import * as anchor from '@coral-xyz/anchor'
import { BN, Program } from '@coral-xyz/anchor'
import { MemePad } from '../target/types/meme_pad'
import { Keypair } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotent, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import { publicKey } from '@metaplex-foundation/umi'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters'
import { findMetadataPda, safeFetchMetadata } from '@metaplex-foundation/mpl-token-metadata'
import { assert, expect } from 'chai'
import { Tokenomics } from './Tokenomics'
import { beforeEach } from 'mocha'

describe('meme-pad', () => {
  const logTxs = false

  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)

  const program = anchor.workspace.MemePad as Program<MemePad>
  const user = provider.wallet as anchor.Wallet
  let mintKeypair: Keypair

  const tokenDecimal = 6
  const metadata = {
    name: 'Solana Gold',
    symbol: 'GOLDSOL',
    uri: 'https://raw.githubusercontent.com/solana-developers/program-examples/new-examples/tokens/tokens/.assets/spl-token.json',
  }

  const authorityKeypair = new Keypair()
  const feeRecipientKeypair = new Keypair()
  const migrationKeypair = user.payer
  const feeBasisPoints = 100
  const tokenSupply = toTokenValue(1_000_000_000n)
  const tokenThreshold = 793_099_999_845_341n
  const curveA = 2_720_310_556n

  const tokenomics = new Tokenomics(curveA)

  before(async () => {
    await program.methods
      .initialize(
        authorityKeypair.publicKey,
        feeRecipientKeypair.publicKey,
        migrationKeypair.publicKey,
        feeBasisPoints,
        toBN(tokenSupply),
        toBN(tokenThreshold),
        toBN(curveA)
      )
      .rpc()
  })

  describe('Initialize Meme Pad', () => {
    it('creates global config and fills with provided data', async () => {
      const [globalConfigAddress] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from('global_config')], program.programId)

      let globalConfig = await program.account.globalConfig.fetch(globalConfigAddress)

      expect(globalConfig.authority.toString()).to.eq(authorityKeypair.publicKey.toString())
      expect(globalConfig.feeRecipient.toString()).to.eq(feeRecipientKeypair.publicKey.toString())
      expect(globalConfig.migrationAccount.toString()).to.eq(migrationKeypair.publicKey.toString())
      expect(globalConfig.feeBasisPoints).to.eq(feeBasisPoints)
      expect(globalConfig.tokenSupply.toString()).to.eq(tokenSupply.toString())
      expect(globalConfig.tokenThreshold.toString()).to.eq(tokenThreshold.toString())
      expect(globalConfig.curveA.toString()).to.eq(curveA.toString())
    })

    it('creates mint authority account', async () => {
      const [mintAuthorityAddress] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from('mint_authority')], program.programId)

      let balance = await provider.connection.getBalance(mintAuthorityAddress)

      expect(balance).to.not.eq(0)
    })
  })

  describe('Create Mint', () => {
    beforeEach(async () => {
      mintKeypair = new Keypair()
    })

    describe('Creation', () => {
      beforeEach(async () => {
        await createMint()
      })

      it('creates correct mint', async () => {
        let mint = await getMint(provider.connection, mintKeypair.publicKey)

        expect(mint.mintAuthority).to.be.null
        expect(mint.supply.toString()).to.eq(tokenSupply.toString())
        expect(mint.decimals).to.eq(tokenDecimal)
      })

      it('creates mint metadata', async () => {
        const umi = createUmi(provider.connection)
        umi.use(walletAdapterIdentity(provider.wallet))

        const metadataPda = findMetadataPda(umi, { mint: publicKey(mintKeypair.publicKey) })
        const fetchedMetadata = await safeFetchMetadata(umi, metadataPda)

        expect(fetchedMetadata.name).to.eq(metadata.name)
        expect(fetchedMetadata.symbol).to.eq(metadata.symbol)
        expect(fetchedMetadata.uri).to.eq(metadata.uri)
      })

      it('mints all tokens to vault', async () => {
        const vaultAddress = getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
        const balance = await provider.connection.getTokenAccountBalance(vaultAddress)

        expect(balance.value.amount).to.eq(tokenSupply.toString())
      })

      it('creates bonding curve', async () => {
        let bondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())

        expect(bondingCurve.reserveSol.toString()).to.eq(0n.toString())
        expect(bondingCurve.reserveToken.toString()).to.eq(tokenThreshold.toString())
        expect(bondingCurve.tokenThreshold.toString()).to.eq(tokenThreshold.toString())
        expect(bondingCurve.curveA.toString()).to.eq(curveA.toString())
      })
    })
  })

  describe('Buy', () => {
    beforeEach(async () => {
      mintKeypair = new Keypair()

      await createMint()
      await createAssociatedTokenAccountIdempotent(provider.connection, user.payer, mintKeypair.publicKey, user.publicKey)
    })

    describe('Initial Buy', () => {
      it('transfers funds', async () => {
        await expectBuy(toTokenValue(120_000_000n))
      })

      it('updates bonding curve reserves', async () => {
        const amount = toTokenValue(240_000_000n)
        const solAmount = tokenomics.calculateSolAmountForBuy(0n, amount)

        await buy(amount, solAmount)

        let bondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())

        expect(bondingCurve.reserveSol.toString()).to.eq(solAmount.toString())
        expect(bondingCurve.reserveToken.toString()).to.eq((tokenThreshold - amount).toString())
      })

      it('fails if sol amount is more than max sol cost', async () => {
        const amount = toTokenValue(500_000_000n)
        const invalidMaxSolAmount = tokenomics.calculateSolAmountForBuy(0n, amount) - 1n

        try {
          await buy(amount, invalidMaxSolAmount)
          assert.fail('The program did not panic')
        } catch (err) {
          assert(err instanceof anchor.AnchorError, 'Unexpected error type')
          const anchorErr = err as anchor.AnchorError
          expect(anchorErr.error.errorCode.code).to.eq('MoreThanMaxSolCost')
          expect(anchorErr.error.errorMessage).to.eq('Calculated sol cost is more than max sol cost')
        }
      })
    })
  })

  describe('Withdraw', () => {
    beforeEach(async () => {
      mintKeypair = new Keypair()
      await createMint()
    })

    it('withdraws', async () => {
      const buyAmount = tokenThreshold
      const buySolAmount = tokenomics.calculateSolAmountForBuy(0n, buyAmount)
      await createAssociatedTokenAccountIdempotent(provider.connection, user.payer, mintKeypair.publicKey, user.publicKey)
      await buy(buyAmount, buySolAmount)

      await expectWithdraw()
    })

    it('fails to withdraw before threshold reached', async () => {
      const buyAmount = toTokenValue(240_000_000n)
      const buySolAmount = tokenomics.calculateSolAmountForBuy(0n, buyAmount)
      await createAssociatedTokenAccountIdempotent(provider.connection, user.payer, mintKeypair.publicKey, user.publicKey)
      await buy(buyAmount, buySolAmount)

      try {
        await withdraw()
        assert.fail('The program did not panic')
      } catch (err) {
        assert(err instanceof anchor.AnchorError, 'Unexpected error type')
        const anchorErr = err as anchor.AnchorError
        expect(anchorErr.error.errorCode.code).to.eq('BondingCurveNotComplete')
        expect(anchorErr.error.errorMessage).to.eq('Withdraw not allowed before threshold reached')
      }
    })
  })

  describe('Sell', () => {
    const buyAmount = toTokenValue(120_000_000n)
    const buySolAmount = tokenomics.calculateSolAmountForBuy(0n, buyAmount)

    beforeEach(async () => {
      mintKeypair = new Keypair()

      await createMint()
      await createAssociatedTokenAccountIdempotent(provider.connection, user.payer, mintKeypair.publicKey, user.publicKey)
      await buy(buyAmount, buySolAmount)
    })

    describe('Sell Tokens', () => {
      it('transfers funds', async () => {
        await expectSell(toTokenValue(60_000_000n))
      })

      it('updates bonding curve reserves', async () => {
        const amount = toTokenValue(100_000_000n)
        const solAmount = tokenomics.calculateSolAmountForSell(await getCirculatingSupply(), amount)

        let initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())

        await sell(amount, solAmount)

        let finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())

        expect(finalBondingCurve.reserveSol.toString()).to.eq((BigInt(initialBondingCurve.reserveSol) - solAmount).toString())
        expect(finalBondingCurve.reserveToken.toString()).to.eq((BigInt(initialBondingCurve.reserveToken) + amount).toString())
      })

      it('fails if sol amount is less than min sol cost', async () => {
        const amount = toTokenValue(100_000_000n)
        const invalidMinSolCost = tokenomics.calculateSolAmountForSell(await getCirculatingSupply(), amount) + 1n

        try {
          await sell(toBN(amount), toBN(invalidMinSolCost))
          assert.fail('The program did not panic')
        } catch (err) {
          assert(err instanceof anchor.AnchorError, 'Unexpected error type')
          const anchorErr = err as anchor.AnchorError
          expect(anchorErr.error.errorCode.code).to.eq('LessThanMinSolCost')
          expect(anchorErr.error.errorMessage).to.eq('Calculated sol cost is less than min sol cost')
        }
      })
    })
  })

  async function createMint(name: string = metadata.name, symbol: string = metadata.symbol, uri: string = metadata.uri) {
    const txSignature = await program.methods
      .create(name, symbol, uri)
      .accounts({
        mintAccount: mintKeypair.publicKey,
      })
      .signers([mintKeypair])
      .rpc()

    if (logTxs) {
      console.log('Create Mint: ', txSignature)
    }
  }

  async function expectBuy(tokenAmount: bigint) {
    const circulatingSupply = await getCirculatingSupply()
    const solAmount = tokenomics.calculateSolAmountForBuy(circulatingSupply, tokenAmount)
    const feeAmount = Number(solAmount / BigInt(feeBasisPoints))

    const initialUserBalance = await provider.connection.getBalance(user.publicKey)
    const initialBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const initialFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)

    const initialUserTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey)
    )
    const initialVaultBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
    )

    const tx = await buy(tokenAmount, solAmount)

    const finalUserBalance = await provider.connection.getBalance(user.publicKey)
    const finalBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)

    const finalUserTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey)
    )
    const finalVaultBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
    )

    const expectedFinalBalance = initialUserBalance - Number(solAmount) - feeAmount - tx.meta.fee

    expect(finalUserBalance).to.eq(expectedFinalBalance)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance + Number(solAmount))
    expect(finalFeeRecipientBalance).to.eq(initialFeeRecipientBalance + feeAmount)
    expect(finalUserTokenBalance.value.amount).to.eq((BigInt(initialUserTokenBalance.value.amount) + tokenAmount).toString())
    expect(finalVaultBalance.value.amount).to.eq((BigInt(initialVaultBalance.value.amount) - tokenAmount).toString())
  }

  async function expectSell(tokenAmount: bigint) {
    const circulatingSupply = await getCirculatingSupply()
    const solAmount = tokenomics.calculateSolAmountForSell(circulatingSupply, tokenAmount)
    const feeAmount = Number(solAmount / BigInt(feeBasisPoints))

    const initialUserBalance = await provider.connection.getBalance(user.publicKey)
    const initialBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const initialFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)

    const initialUserTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey)
    )
    const initialVaultBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
    )

    const tx = await sell(tokenAmount, solAmount)

    const finalUserBalance = await provider.connection.getBalance(user.publicKey)
    const finalBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)

    const finalUserTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey)
    )
    const finalVaultBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
    )

    const expectedFinalBalance = initialUserBalance + Number(solAmount) - feeAmount - tx.meta.fee

    expect(finalUserBalance).to.eq(expectedFinalBalance)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance - Number(solAmount))
    expect(finalFeeRecipientBalance).to.eq(initialFeeRecipientBalance + feeAmount)
    expect(finalUserTokenBalance.value.amount).to.eq((BigInt(initialUserTokenBalance.value.amount) - tokenAmount).toString())
    expect(finalVaultBalance.value.amount).to.eq((BigInt(initialVaultBalance.value.amount) + tokenAmount).toString())
  }

  async function expectWithdraw() {
    const initialMigrationBalance = await provider.connection.getBalance(migrationKeypair.publicKey)
    const initialBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())
    const initialMigrationTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, migrationKeypair.publicKey)
    )

    const tx = await withdraw()

    const finalMigrationBalance = await provider.connection.getBalance(migrationKeypair.publicKey)
    const finalBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())
    const finalMigrationTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, migrationKeypair.publicKey)
    )
    const finalVaultBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
    )

    expect(finalMigrationBalance).to.eq(initialMigrationBalance + initialBondingCurve.reserveSol.toNumber() - tx.meta.fee)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance - initialBondingCurve.reserveSol.toNumber())
    const remainingTokens = tokenSupply - tokenThreshold
    expect(finalMigrationTokenBalance.value.amount).to.eq((BigInt(initialMigrationTokenBalance.value.amount) + remainingTokens).toString())
    expect(finalVaultBalance.value.amount).to.eq('0')
    expect(finalBondingCurve.reserveToken.toNumber()).to.eq(0)
    expect(finalBondingCurve.reserveSol.toNumber()).to.eq(0)
  }

  async function buy(amount: bigint, maxSolCost: bigint) {
    const txSignature = await program.methods
      .buy(toBN(amount), toBN(maxSolCost))
      .accounts({
        mintAccount: mintKeypair.publicKey,
      })
      .rpc({ commitment: 'confirmed' })

    if (logTxs) {
      console.log('Buy: ', txSignature)
    }

    return await provider.connection.getParsedTransaction(txSignature, 'confirmed')
  }

  async function sell(amount: bigint, minSolCost: bigint) {
    const txSignature = await program.methods
      .sell(toBN(amount), toBN(minSolCost))
      .accounts({
        mintAccount: mintKeypair.publicKey,
      })
      .rpc({ commitment: 'confirmed' })

    if (logTxs) {
      console.log('Sell: ', txSignature)
    }

    return await provider.connection.getParsedTransaction(txSignature, 'confirmed')
  }

  async function withdraw() {
    const txSignature = await program.methods
      .withdraw()
      .accounts({
        mintAccount: mintKeypair.publicKey,
      })
      .rpc({ commitment: 'confirmed' })

    if (logTxs) {
      console.log('Withdraw: ', txSignature)
    }

    return await provider.connection.getParsedTransaction(txSignature, 'confirmed')
  }

  function getBondingCurveAddress() {
    const [bondingCurveAddress] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('bonding_curve'), mintKeypair.publicKey.toBuffer()],
      program.programId
    )

    return bondingCurveAddress
  }

  async function getCirculatingSupply() {
    let bondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())
    return tokenThreshold - fromBN(bondingCurve.reserveToken)
  }

  function toTokenValue(value: bigint) {
    return value * 10n ** BigInt(tokenDecimal)
  }

  function toBN(value: bigint) {
    return new BN(value.toString())
  }

  function fromBN(value: BN) {
    return BigInt(value)
  }
})
