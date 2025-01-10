import * as anchor from '@coral-xyz/anchor'
import { BN, Program } from '@coral-xyz/anchor'
import { MemePad } from '../target/types/meme_pad'
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
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
  const solThreshold = 85_000_000_062n

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
        await expectBuy(5n * BigInt(LAMPORTS_PER_SOL))
      })

      it('updates bonding curve reserves', async () => {
        const solAmount = 10n * BigInt(LAMPORTS_PER_SOL)
        const calculatedTokenAmount = tokenomics.calculateTokenAmount(0n, solAmount)

        await buy(solAmount, calculatedTokenAmount)

        let bondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())

        expect(fromBN(bondingCurve.reserveSol)).to.eq(solAmount)
        expect(fromBN(bondingCurve.reserveToken)).to.eq(tokenThreshold - calculatedTokenAmount)
      })

      it('fails if token amount is less than min token receive', async () => {
        const solAmount = 20n * BigInt(LAMPORTS_PER_SOL)
        const invalidMinTokenReceive = tokenomics.calculateTokenAmount(0n, solAmount) + 1n

        try {
          await buy(solAmount, invalidMinTokenReceive)
          assert.fail('The program did not panic')
        } catch (err) {
          assert(err instanceof anchor.AnchorError, 'Unexpected error type')
          const anchorErr = err as anchor.AnchorError
          expect(anchorErr.error.errorCode.code).to.eq('LessThanMinTokenReceive')
          expect(anchorErr.error.errorMessage).to.eq('Calculated token amount is less than min token receive')
        }
      })
    })

    describe('Last Buy', () => {
      it('buys remaining tokens with correct min receive', async () => {
        const remainingSols = 5n * BigInt(LAMPORTS_PER_SOL)
        const solAmount = solThreshold - remainingSols
        const calculatedTokenAmount = tokenomics.calculateTokenAmount(0n, solAmount)
        await buy(solAmount, calculatedTokenAmount)

        const initialUserBalance = await getBalance(user.publicKey)
        const initialBondingCurveBalance = await getBalance(getBondingCurveAddress())
        const initialUserTokenBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey))
        const initialVaultBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true))
        const remainingTokens = tokenThreshold - calculatedTokenAmount

        const tx = await buy(remainingSols * 2n + 2n, remainingTokens * 2n)

        const finalUserBalance = await getBalance(user.publicKey)
        const finalBondingCurveBalance = await getBalance(getBondingCurveAddress())
        const finalUserTokenBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey))
        const finalVaultBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true))

        const feeAmount = remainingSols / BigInt(feeBasisPoints)
        const expectedFinalBalance = initialUserBalance - remainingSols - feeAmount - BigInt(tx.meta.fee.toString())

        expect(finalUserBalance).to.be.closeToBigInt(expectedFinalBalance, 50n)
        expect(finalBondingCurveBalance).to.closeToBigInt(initialBondingCurveBalance + remainingSols, 1n)
        expect(finalUserTokenBalance).to.eq(initialUserTokenBalance + remainingTokens)
        expect(finalVaultBalance).to.eq(initialVaultBalance - remainingTokens)
      })

      it.only('fails to buy remaining tokens with incorrect min receive', async () => {
        const remainingSols = 5n * BigInt(LAMPORTS_PER_SOL)
        const solAmount = solThreshold - remainingSols
        const calculatedTokenAmount = tokenomics.calculateTokenAmount(0n, solAmount)
        await buy(solAmount, calculatedTokenAmount)

        const remainingTokens = tokenThreshold - calculatedTokenAmount

        try {
          await buy(remainingSols * 2n + 2n, remainingTokens * 2n + 100n)
          assert.fail('The program did not panic')
        } catch (err) {
          assert(err instanceof anchor.AnchorError, 'Unexpected error type')
          const anchorErr = err as anchor.AnchorError
          expect(anchorErr.error.errorCode.code).to.eq('LessThanMinTokenReceive')
          expect(anchorErr.error.errorMessage).to.eq('Calculated token amount is less than min token receive')
        }
      })
    })
  })

  describe('Sell', () => {
    const buyAmount = 50n * BigInt(LAMPORTS_PER_SOL)
    const calculatedTokenAmount = tokenomics.calculateTokenAmount(0n, buyAmount)

    beforeEach(async () => {
      mintKeypair = new Keypair()

      await createMint()
      await createAssociatedTokenAccountIdempotent(provider.connection, user.payer, mintKeypair.publicKey, user.publicKey)
      await buy(buyAmount, calculatedTokenAmount)
    })

    describe('Sell Tokens', () => {
      it('transfers funds', async () => {
        await expectSell(toTokenValue(60_000_000n))
      })

      it('updates bonding curve reserves', async () => {
        const amount = toTokenValue(100_000_000n)
        const calculatedSolAmount = tokenomics.calculateSolAmount(await getCirculatingSupply(), amount)

        let initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())

        await sell(amount, calculatedSolAmount)

        let finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())

        expect(fromBN(finalBondingCurve.reserveSol)).to.eq(fromBN(initialBondingCurve.reserveSol) - calculatedSolAmount)
        expect(fromBN(finalBondingCurve.reserveToken)).to.eq(fromBN(initialBondingCurve.reserveToken) + amount)
      })

      it('fails if sol amount is less than min sol receive', async () => {
        const amount = toTokenValue(200_000_000n)
        const invalidMinSolReceive = tokenomics.calculateSolAmount(await getCirculatingSupply(), amount) + 1n

        try {
          await sell(toBN(amount), toBN(invalidMinSolReceive))
          assert.fail('The program did not panic')
        } catch (err) {
          assert(err instanceof anchor.AnchorError, 'Unexpected error type')
          const anchorErr = err as anchor.AnchorError
          expect(anchorErr.error.errorCode.code).to.eq('LessThanMinSolReceive')
          expect(anchorErr.error.errorMessage).to.eq('Calculated sol amount is less than min sol receive')
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
      await createAssociatedTokenAccountIdempotent(provider.connection, user.payer, mintKeypair.publicKey, user.publicKey)
      await buy(solThreshold * 2n, tokenThreshold)

      await expectWithdraw()
    })

    it('fails to withdraw before threshold reached', async () => {
      const buyAmount = 50n * BigInt(LAMPORTS_PER_SOL)
      const calculatedTokenAmount = tokenomics.calculateTokenAmount(0n, buyAmount)
      await createAssociatedTokenAccountIdempotent(provider.connection, user.payer, mintKeypair.publicKey, user.publicKey)
      await buy(buyAmount, calculatedTokenAmount)

      try {
        await withdraw()
        assert.fail('The program did not panic')
      } catch (err) {
        assert(err instanceof anchor.AnchorError, 'Unexpected error type')
        const anchorErr = err as anchor.AnchorError
        expect(anchorErr.error.errorCode.code).to.eq('BondingCurveNotComplete')
        expect(anchorErr.error.errorMessage).to.eq('Withdraw not allowed before bonding curve is complete')
      }
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

  async function expectBuy(solAmount: bigint) {
    const circulatingSupply = await getCirculatingSupply()
    const calculatedTokenAmount = tokenomics.calculateTokenAmount(circulatingSupply, solAmount)
    const feeAmount = solAmount / BigInt(feeBasisPoints)

    const initialUserBalance = await getBalance(user.publicKey)
    const initialBondingCurveBalance = await getBalance(getBondingCurveAddress())
    const initialFeeRecipientBalance = await getBalance(feeRecipientKeypair.publicKey)

    const initialUserTokenBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey))
    const initialVaultBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true))

    const tx = await buy(solAmount, calculatedTokenAmount)

    const finalUserBalance = await getBalance(user.publicKey)
    const finalBondingCurveBalance = await getBalance(getBondingCurveAddress())
    const finalFeeRecipientBalance = await getBalance(feeRecipientKeypair.publicKey)

    const finalUserTokenBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey))
    const finalVaultBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true))

    const expectedFinalBalance = initialUserBalance - solAmount - feeAmount - BigInt(tx.meta.fee.toString())

    expect(finalUserBalance).to.be.closeToBigInt(expectedFinalBalance, 50n)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance + solAmount)
    expect(finalFeeRecipientBalance).to.eq(initialFeeRecipientBalance + feeAmount)
    expect(finalUserTokenBalance).to.eq(initialUserTokenBalance + calculatedTokenAmount)
    expect(finalVaultBalance).to.eq(initialVaultBalance - calculatedTokenAmount)
  }

  async function expectSell(tokenAmount: bigint) {
    const circulatingSupply = await getCirculatingSupply()
    const calculatedSolAmount = tokenomics.calculateSolAmount(circulatingSupply, tokenAmount)
    const feeAmount = calculatedSolAmount / BigInt(feeBasisPoints)

    const initialUserBalance = await getBalance(user.publicKey)
    const initialBondingCurveBalance = await getBalance(getBondingCurveAddress())
    const initialFeeRecipientBalance = await getBalance(feeRecipientKeypair.publicKey)

    const initialUserTokenBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey))
    const initialVaultBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true))

    const tx = await sell(tokenAmount, calculatedSolAmount)

    const finalUserBalance = await getBalance(user.publicKey)
    const finalBondingCurveBalance = await getBalance(getBondingCurveAddress())
    const finalFeeRecipientBalance = await getBalance(feeRecipientKeypair.publicKey)

    const finalUserTokenBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey))
    const finalVaultBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true))

    const expectedFinalBalance = initialUserBalance + calculatedSolAmount - feeAmount - BigInt(tx.meta.fee.toString())

    expect(finalUserBalance).to.be.closeToBigInt(expectedFinalBalance, 50n)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance - calculatedSolAmount)
    expect(finalFeeRecipientBalance).to.eq(initialFeeRecipientBalance + feeAmount)
    expect(finalUserTokenBalance).to.eq(initialUserTokenBalance - tokenAmount)
    expect(finalVaultBalance).to.eq(initialVaultBalance + tokenAmount)
  }

  async function expectWithdraw() {
    const initialMigrationBalance = await getBalance(migrationKeypair.publicKey)
    const initialBondingCurveBalance = await getBalance(getBondingCurveAddress())
    const initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())
    const initialMigrationTokenBalance = await getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, migrationKeypair.publicKey)
    )

    const tx = await withdraw()

    const finalMigrationBalance = await getBalance(migrationKeypair.publicKey)
    const finalBondingCurveBalance = await getBalance(getBondingCurveAddress())
    const finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress())
    const finalMigrationTokenBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, migrationKeypair.publicKey))
    const finalVaultBalance = await getTokenAccountBalance(getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true))

    expect(finalMigrationBalance).to.be.closeToBigInt(
      initialMigrationBalance + fromBN(initialBondingCurve.reserveSol) - BigInt(tx.meta.fee.toString()),
      100n
    )
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance - fromBN(initialBondingCurve.reserveSol))
    const remainingTokens = tokenSupply - tokenThreshold
    expect(finalMigrationTokenBalance).to.eq(initialMigrationTokenBalance + remainingTokens)
    expect(finalVaultBalance).to.eq(0n)
    expect(fromBN(finalBondingCurve.reserveToken)).to.eq(0n)
    expect(fromBN(finalBondingCurve.reserveSol)).to.eq(0n)
  }

  async function buy(solAmount: bigint, minTokenReceive: bigint) {
    const txSignature = await program.methods
      .buy(toBN(solAmount), toBN(minTokenReceive))
      .accounts({
        mintAccount: mintKeypair.publicKey,
      })
      .rpc({ commitment: 'confirmed' })

    if (logTxs) {
      console.log('Buy: ', txSignature)
    }

    return await provider.connection.getParsedTransaction(txSignature, 'confirmed')
  }

  async function sell(tokenAmount: bigint, minSolReceive: bigint) {
    const txSignature = await program.methods
      .sell(toBN(tokenAmount), toBN(minSolReceive))
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

  async function getBalance(address: PublicKey) {
    const balance = await provider.connection.getBalance(address)
    return BigInt(balance.toString())
  }

  async function getTokenAccountBalance(address: PublicKey) {
    const balance = await provider.connection.getTokenAccountBalance(address)
    return BigInt(balance.value.amount)
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
