import * as anchor from '@coral-xyz/anchor'
import { BN, Program } from '@coral-xyz/anchor'
import { MemePad } from '../target/types/meme_pad'
import { Keypair, type PublicKey } from '@solana/web3.js'
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
  const feeBasisPoints = 80
  const tokenSupply = toTokenValue(1_000_000_000n)

  const tokenThreshold = 793_099_999_845_341n
  const curveA = 2_720_310_556n
  // const tokenThreshold = 800_000_000_000_000n
  // const curveA = 100_000_000_000n

  const tokenomics = new Tokenomics(curveA)
  const curveSol = tokenomics.calculateSolAmountForBuy(tokenThreshold, tokenThreshold)

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
      .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' })
  })

  describe('Initialize Meme Pad', () => {
    it('creates global config and fills with provided data', async () => {
      const [globalConfigAddress] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from('global_config')], program.programId)

      let globalConfig = await program.account.globalConfig.fetch(globalConfigAddress, 'confirmed')

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
      let bondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

      expect(bondingCurve.reserveSol.toString()).to.eq(0n.toString())
      expect(bondingCurve.reserveToken.toString()).to.eq(tokenThreshold.toString())
      expect(bondingCurve.tokenThreshold.toString()).to.eq(tokenThreshold.toString())
      expect(bondingCurve.curveA.toString()).to.eq(curveA.toString())
    })
  })

  describe('Buy', () => {
    beforeEach(async () => {
      mintKeypair = new Keypair()

      await createMint()
      await createTokenAccount(mintKeypair.publicKey, user.publicKey)
    })

    it('buys tokens correctly', async () => {
      const solAmount = BigInt(curveSol) / 10n
      const tokenAmount = tokenomics.calculateTokenAmount(0n, tokenThreshold, solAmount)

      await expectBuy(solAmount, tokenAmount, solAmount, tokenAmount)
    })

    it('buys tokens left when reaching threshold', async () => {
      await buy(BigInt(curveSol) / 2n, 0n)

      const solAmount = BigInt(curveSol)
      const circulatingSupply = await getCirculatingSupply()
      const tokenAmount = tokenomics.calculateTokenAmount(circulatingSupply, tokenThreshold, solAmount)
      const expectedSolAmount = tokenomics.calculateSolAmountForBuy(circulatingSupply + tokenAmount, tokenAmount)

      await expectBuy(solAmount, tokenAmount, expectedSolAmount, tokenAmount)
    })

    it('buys tokens left when reaching threshold if his tx is overrun', async () => {
      await buy(BigInt(curveSol) / 2n, 0n)

      const solAmount = BigInt(curveSol)
      const minTokenAmount = tokenomics.calculateTokenAmount(await getCirculatingSupply(), tokenThreshold, solAmount)

      await buy(BigInt(curveSol) / 4n, 0n)

      const circulatingSupply = await getCirculatingSupply()
      const tokenAmount = tokenomics.calculateTokenAmount(circulatingSupply, tokenThreshold, solAmount)
      const expectedSolAmount = tokenomics.calculateSolAmountForBuy(circulatingSupply + tokenAmount, tokenAmount)

      await expectBuy(solAmount, minTokenAmount, expectedSolAmount, tokenAmount)
    })

    it('fails if token amount is less than min token amount', async () => {
      const solAmount = BigInt(curveSol) / 2n
      const invalidMinTokenAmount = tokenomics.calculateTokenAmount(0n, tokenThreshold, solAmount) + 1n

      try {
        await buy(solAmount, invalidMinTokenAmount)
        assert.fail('The program did not panic')
      } catch (err) {
        assert(err instanceof anchor.AnchorError, 'Unexpected error type')
        const anchorErr = err as anchor.AnchorError
        expect(anchorErr.error.errorCode.code).to.eq('LessThanMinTokenAmount')
        expect(anchorErr.error.errorMessage).to.eq('Calculated token amount is less than min token amount')
      }
    })

    it('fails if amount is zero', async () => {
      try {
        await buy(0n, 0n)
        assert.fail('The program did not panic')
      } catch (err) {
        assert(err instanceof anchor.AnchorError, 'Unexpected error type')
        const anchorErr = err as anchor.AnchorError
        expect(anchorErr.error.errorCode.code).to.eq('ZeroAmount')
        expect(anchorErr.error.errorMessage).to.eq('Trade not allow for zero amount')
      }
    })

    it('fails if curve is complete', async () => {
      await buy(curveSol, 0n)

      try {
        await buy(BigInt(curveSol) / 10n, 0n)
        assert.fail('The program did not panic')
      } catch (err) {
        assert(err instanceof anchor.AnchorError, 'Unexpected error type')
        const anchorErr = err as anchor.AnchorError
        expect(anchorErr.error.errorCode.code).to.eq('BondingCurveCompleted')
        expect(anchorErr.error.errorMessage).to.eq('Trade not allowed after threshold reached')
      }
    })
  })

  describe('Sell', () => {
    const buyAmount = BigInt(curveSol) / 5n
    const buyTokenAmount = tokenomics.calculateTokenAmount(0n, tokenThreshold, buyAmount)

    beforeEach(async () => {
      mintKeypair = new Keypair()

      await createMint()
      await createTokenAccount(mintKeypair.publicKey, user.publicKey)
      await buy(buyAmount, buyTokenAmount)
    })

    it('sells tokens correctly', async () => {
      await expectSell(buyTokenAmount / 2n)
    })

    it('sells 1 token correctly', async () => {
      await expectSell(1n)
    })

    it('fails if sol amount is less than min sol amount', async () => {
      const amount = buyTokenAmount
      const invalidMinSolAmount = tokenomics.calculateSolAmountForSell(await getCirculatingSupply(), amount) + 1n

      try {
        await sell(toBN(amount), toBN(invalidMinSolAmount))
        assert.fail('The program did not panic')
      } catch (err) {
        assert(err instanceof anchor.AnchorError, 'Unexpected error type')
        const anchorErr = err as anchor.AnchorError
        expect(anchorErr.error.errorCode.code).to.eq('LessThanMinSolAmount')
        expect(anchorErr.error.errorMessage).to.eq('Calculated sol amount is less than min sol amount')
      }
    })

    it('fails if curve is complete', async () => {
      await buy(curveSol, 0n)

      try {
        await sell(buyTokenAmount, 0n)
        assert.fail('The program did not panic')
      } catch (err) {
        assert(err instanceof anchor.AnchorError, 'Unexpected error type')
        const anchorErr = err as anchor.AnchorError
        expect(anchorErr.error.errorCode.code).to.eq('BondingCurveCompleted')
        expect(anchorErr.error.errorMessage).to.eq('Trade not allowed after threshold reached')
      }
    })
  })

  describe('Withdraw', () => {
    beforeEach(async () => {
      mintKeypair = new Keypair()
      await createMint()
      await createTokenAccount(mintKeypair.publicKey, user.publicKey)
    })

    it('withdraws', async () => {
      await buy(BigInt(curveSol), 0n)
      await expectWithdraw()
    })

    it('fails to withdraw before threshold reached', async () => {
      await buy(BigInt(curveSol) / 2n, 0n)

      try {
        await withdraw()
        assert.fail('The program did not panic')
      } catch (err) {
        assert(err instanceof anchor.AnchorError, 'Unexpected error type')
        const anchorErr = err as anchor.AnchorError
        expect(anchorErr.error.errorCode.code).to.eq('BondingCurveNotCompleted')
        expect(anchorErr.error.errorMessage).to.eq('Withdraw not allowed before threshold reached')
      }
    })

    it('fails to withdraw more than once', async () => {
      await buy(BigInt(curveSol), 0n)
      await withdraw()

      try {
        await withdraw()
        assert.fail('The program did not panic')
      } catch (err) {
        assert(err instanceof anchor.AnchorError, 'Unexpected error type')
        const anchorErr = err as anchor.AnchorError
        expect(anchorErr.error.errorCode.code).to.eq('AlreadyWithdrawn')
        expect(anchorErr.error.errorMessage).to.eq('Already withdrawn')
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
      .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' })

    if (logTxs) {
      console.log('Create Mint: ', txSignature)
    }
  }

  async function createTokenAccount(mint: PublicKey, owner: PublicKey) {
    await createAssociatedTokenAccountIdempotent(provider.connection, user.payer, mint, owner, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    })
  }

  async function expectBuy(solAmount: bigint, minTokenAmount: bigint, expectedSolAmount: bigint, expectedTokenAmount: bigint) {
    const feeAmount = Number((expectedSolAmount * BigInt(feeBasisPoints)) / 10_000n)

    const initialUserBalance = await provider.connection.getBalance(user.publicKey)
    const initialBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const initialFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)
    const initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

    const initialUserTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey)
    )
    const initialVaultBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
    )

    const tx = await buy(solAmount, minTokenAmount)

    const finalUserBalance = await provider.connection.getBalance(user.publicKey)
    const finalBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)
    const finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

    const finalUserTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey)
    )
    const finalVaultBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
    )

    const expectedFinalBalance = initialUserBalance - Number(expectedSolAmount) - feeAmount - tx.meta.fee

    expect(finalUserBalance).to.be.closeTo(expectedFinalBalance, 100)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance + Number(expectedSolAmount))
    expect(finalFeeRecipientBalance).to.eq(initialFeeRecipientBalance + feeAmount)
    expect(finalUserTokenBalance.value.amount).to.eq((BigInt(initialUserTokenBalance.value.amount) + expectedTokenAmount).toString())
    expect(finalVaultBalance.value.amount).to.eq((BigInt(initialVaultBalance.value.amount) - expectedTokenAmount).toString())

    expect(fromBN(finalBondingCurve.reserveSol) - fromBN(initialBondingCurve.reserveSol)).to.eq(expectedSolAmount)
    expect(fromBN(initialBondingCurve.reserveToken) - fromBN(finalBondingCurve.reserveToken)).to.eq(expectedTokenAmount)
  }

  async function expectSell(tokenAmount: bigint) {
    const circulatingSupply = await getCirculatingSupply()
    const solAmount = tokenomics.calculateSolAmountForSell(circulatingSupply, tokenAmount)
    const feeAmount = Number((solAmount * BigInt(feeBasisPoints)) / 10_000n)

    const initialUserBalance = await provider.connection.getBalance(user.publicKey)
    const initialBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const initialFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)
    const initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

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
    const finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

    const finalUserTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, user.publicKey)
    )
    const finalVaultBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
    )

    const expectedFinalBalance = initialUserBalance + Number(solAmount) - feeAmount - tx.meta.fee

    expect(finalUserBalance).to.be.closeTo(expectedFinalBalance, 100)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance - Number(solAmount))
    expect(finalFeeRecipientBalance).to.eq(initialFeeRecipientBalance + feeAmount)
    expect(finalUserTokenBalance.value.amount).to.eq((BigInt(initialUserTokenBalance.value.amount) - tokenAmount).toString())
    expect(finalVaultBalance.value.amount).to.eq((BigInt(initialVaultBalance.value.amount) + tokenAmount).toString())

    expect(fromBN(initialBondingCurve.reserveSol) - fromBN(finalBondingCurve.reserveSol)).to.eq(solAmount)
    expect(fromBN(finalBondingCurve.reserveToken) - fromBN(initialBondingCurve.reserveToken)).to.eq(tokenAmount)
  }

  async function expectWithdraw() {
    const initialMigrationBalance = await provider.connection.getBalance(migrationKeypair.publicKey)
    const initialBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')
    const initialMigrationTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, migrationKeypair.publicKey)
    )

    const tx = await withdraw()

    const finalMigrationBalance = await provider.connection.getBalance(migrationKeypair.publicKey)
    const finalBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')
    const finalMigrationTokenBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, migrationKeypair.publicKey)
    )
    const finalVaultBalance = await provider.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(mintKeypair.publicKey, getBondingCurveAddress(), true)
    )

    expect(finalMigrationBalance).to.be.closeTo(initialMigrationBalance + initialBondingCurve.reserveSol.toNumber() - tx.meta.fee, 100)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance - initialBondingCurve.reserveSol.toNumber())
    const remainingTokens = tokenSupply - tokenThreshold
    expect(finalMigrationTokenBalance.value.amount).to.eq((BigInt(initialMigrationTokenBalance.value.amount) + remainingTokens).toString())
    expect(finalVaultBalance.value.amount).to.eq('0')
    expect(finalBondingCurve.reserveToken.toNumber()).to.eq(0)
    expect(finalBondingCurve.reserveSol.toNumber()).to.eq(0)
  }

  async function buy(solAmount: bigint, minTokenAmount: bigint) {
    const txSignature = await program.methods
      .buy(toBN(solAmount), toBN(minTokenAmount))
      .accounts({
        mintAccount: mintKeypair.publicKey,
      })
      .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' })

    if (logTxs) {
      console.log('Buy: ', txSignature)
    }

    return await provider.connection.getParsedTransaction(txSignature, 'confirmed')
  }

  async function sell(tokenAmount: bigint, minSolAmount: bigint) {
    const txSignature = await program.methods
      .sell(toBN(tokenAmount), toBN(minSolAmount))
      .accounts({
        mintAccount: mintKeypair.publicKey,
      })
      .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' })

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
      .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' })

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
    let bondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')
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
