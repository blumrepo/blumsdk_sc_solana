import * as anchor from '@coral-xyz/anchor'
import { BN, Program } from '@coral-xyz/anchor'
import { MemePad } from '../target/types/meme_pad'
import { Keypair, LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js'
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
  const partnerPubKey = new Keypair().publicKey

  const deployFee = BigInt(0.5 * LAMPORTS_PER_SOL)
  const buyFeeBps = 130
  const sellFeeBps = 80

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
        toBN(deployFee),
        buyFeeBps,
        sellFeeBps,
        toBN(tokenSupply),
        toBN(tokenThreshold),
        toBN(curveA)
      )
      .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' })
  })

  describe('Initialize Meme Pad', () => {
    it('creates global config and fills with provided data', async () => {
      let globalConfig = await fetchGlobalConfig()

      expect(globalConfig.authority.toString()).to.eq(authorityKeypair.publicKey.toString())
      expect(globalConfig.feeRecipient.toString()).to.eq(feeRecipientKeypair.publicKey.toString())
      expect(globalConfig.migrationAccount.toString()).to.eq(migrationKeypair.publicKey.toString())
      expect(fromBN(globalConfig.deployFee)).to.eq(deployFee)
      expect(globalConfig.buyFeeBps).to.eq(buyFeeBps)
      expect(globalConfig.sellFeeBps).to.eq(sellFeeBps)
      expect(fromBN(globalConfig.tokenSupply)).to.eq(tokenSupply)
      expect(fromBN(globalConfig.tokenThreshold)).to.eq(tokenThreshold)
      expect(fromBN(globalConfig.curveA)).to.eq(curveA)
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

    it('creates correct mint', async () => {
      await createMint()

      let mint = await getMint(provider.connection, mintKeypair.publicKey)

      const umi = createUmi(provider.connection)
      umi.use(walletAdapterIdentity(provider.wallet))

      const metadataPda = findMetadataPda(umi, { mint: publicKey(mintKeypair.publicKey) })
      const fetchedMetadata = await safeFetchMetadata(umi, metadataPda)

      expect(mint.mintAuthority).to.be.null
      expect(mint.supply.toString()).to.eq(tokenSupply.toString())
      expect(mint.decimals).to.eq(tokenDecimal)

      expect(fetchedMetadata.name).to.eq(metadata.name)
      expect(fetchedMetadata.symbol).to.eq(metadata.symbol)
      expect(fetchedMetadata.uri).to.eq(metadata.uri)
    })

    it('mints all tokens to vault', async () => {
      await createMint()

      const balance = await getTokenBalance(getBondingCurveAddress(), true)

      expect(balance.toString()).to.eq(tokenSupply.toString())
    })

    it('creates bonding curve', async () => {
      await createMint()

      let bondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

      expect(bondingCurve.reserveSol.toString()).to.eq(0n.toString())
      expect(bondingCurve.reserveToken.toString()).to.eq(tokenThreshold.toString())
      expect(bondingCurve.tokenThreshold.toString()).to.eq(tokenThreshold.toString())
      expect(bondingCurve.curveA.toString()).to.eq(curveA.toString())
    })

    it('creates bonding curve', async () => {
      const initialFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)
      await createMint()
      const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)

      expect(finalFeeRecipientBalance).to.eq(initialFeeRecipientBalance + Number(deployFee))
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

  describe('Update Global Config', () => {
    it('updates global config with provided data', async () => {
      const newAuthorityKeypair = new Keypair()
      const newFeeRecipientKeypair = new Keypair()
      const newMigrationKeypair = new Keypair()
      const newDeployFee = BigInt(2 * LAMPORTS_PER_SOL)
      const newBuyFeeBps = 150
      const newSellFeeBps = 50
      const newTokenSupply = toTokenValue(2_000_000_000n)
      const newTokenThreshold = 400_000_000_000_000n
      const newCurveA = 3_000_000_000n

      const txSignature = await program.methods
        .updateConfig(
          newAuthorityKeypair.publicKey,
          newFeeRecipientKeypair.publicKey,
          newMigrationKeypair.publicKey,
          toBN(newDeployFee),
          newBuyFeeBps,
          newSellFeeBps,
          toBN(newTokenSupply),
          toBN(newTokenThreshold),
          toBN(newCurveA)
        )
        .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' })

      if (logTxs) {
        console.log('Update Global Config: ', txSignature)
      }

      let globalConfig = await fetchGlobalConfig()

      expect(globalConfig.authority.toString()).to.eq(newAuthorityKeypair.publicKey.toString())
      expect(globalConfig.feeRecipient.toString()).to.eq(newFeeRecipientKeypair.publicKey.toString())
      expect(globalConfig.migrationAccount.toString()).to.eq(newMigrationKeypair.publicKey.toString())
      expect(fromBN(globalConfig.deployFee)).to.eq(newDeployFee)
      expect(globalConfig.buyFeeBps).to.eq(newBuyFeeBps)
      expect(globalConfig.sellFeeBps).to.eq(newSellFeeBps)
      expect(fromBN(globalConfig.tokenSupply)).to.eq(newTokenSupply)
      expect(fromBN(globalConfig.tokenThreshold)).to.eq(newTokenThreshold)
      expect(fromBN(globalConfig.curveA)).to.eq(newCurveA)
    })

    it('updates global config partially', async () => {
      let oldGlobalConfig = await fetchGlobalConfig()

      const newAuthorityKeypair = new Keypair()
      const newMigrationKeypair = new Keypair()
      const newBuyFeeBps = 150
      const newTokenSupply = toTokenValue(2_000_000_000n)
      const newCurveA = 3_000_000_000n

      const txSignature = await program.methods
        .updateConfig(
          newAuthorityKeypair.publicKey,
          null,
          newMigrationKeypair.publicKey,
          null,
          newBuyFeeBps,
          null,
          toBN(newTokenSupply),
          null,
          toBN(newCurveA)
        )
        .rpc({ commitment: 'confirmed', preflightCommitment: 'confirmed' })

      if (logTxs) {
        console.log('Update Global Config: ', txSignature)
      }

      let globalConfig = await fetchGlobalConfig()

      expect(globalConfig.authority.toString()).to.eq(newAuthorityKeypair.publicKey.toString())
      expect(globalConfig.feeRecipient.toString()).to.eq(oldGlobalConfig.feeRecipient.toString())
      expect(globalConfig.migrationAccount.toString()).to.eq(newMigrationKeypair.publicKey.toString())
      expect(fromBN(globalConfig.deployFee)).to.eq(fromBN(oldGlobalConfig.deployFee))
      expect(globalConfig.buyFeeBps).to.eq(newBuyFeeBps)
      expect(globalConfig.sellFeeBps).to.eq(oldGlobalConfig.sellFeeBps)
      expect(fromBN(globalConfig.tokenSupply)).to.eq(newTokenSupply)
      expect(fromBN(globalConfig.tokenThreshold)).to.eq(fromBN(oldGlobalConfig.tokenThreshold))
      expect(fromBN(globalConfig.curveA)).to.eq(newCurveA)
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
    const feeAmount = Number((expectedSolAmount * BigInt(buyFeeBps)) / 10_000n)

    const initialUserBalance = await provider.connection.getBalance(user.publicKey)
    const initialBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const initialFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)
    const initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

    const initialUserTokenBalance = await getTokenBalance(user.publicKey)
    const initialVaultBalance = await getTokenBalance(getBondingCurveAddress(), true)

    const tx = await buy(solAmount, minTokenAmount)

    const finalUserBalance = await provider.connection.getBalance(user.publicKey)
    const finalBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)
    const finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

    const finalUserTokenBalance = await getTokenBalance(user.publicKey)
    const finalVaultBalance = await getTokenBalance(getBondingCurveAddress(), true)

    const expectedFinalBalance = initialUserBalance - Number(expectedSolAmount) - feeAmount - tx.meta.fee

    expect(finalUserBalance).to.be.closeTo(expectedFinalBalance, 100)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance + Number(expectedSolAmount))
    expect(finalFeeRecipientBalance).to.eq(initialFeeRecipientBalance + feeAmount)
    expect(finalUserTokenBalance.toString()).to.eq((initialUserTokenBalance + expectedTokenAmount).toString())
    expect(finalVaultBalance.toString()).to.eq((initialVaultBalance - expectedTokenAmount).toString())

    expect(fromBN(finalBondingCurve.reserveSol) - fromBN(initialBondingCurve.reserveSol)).to.eq(expectedSolAmount)
    expect(fromBN(initialBondingCurve.reserveToken) - fromBN(finalBondingCurve.reserveToken)).to.eq(expectedTokenAmount)
  }

  async function expectSell(tokenAmount: bigint) {
    const circulatingSupply = await getCirculatingSupply()
    const solAmount = tokenomics.calculateSolAmountForSell(circulatingSupply, tokenAmount)
    const feeAmount = Number((solAmount * BigInt(sellFeeBps)) / 10_000n)

    const initialUserBalance = await provider.connection.getBalance(user.publicKey)
    const initialBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const initialFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)
    const initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

    const initialUserTokenBalance = await getTokenBalance(user.publicKey)
    const initialVaultBalance = await getTokenBalance(getBondingCurveAddress(), true)

    const tx = await sell(tokenAmount, solAmount)

    const finalUserBalance = await provider.connection.getBalance(user.publicKey)
    const finalBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientKeypair.publicKey)
    const finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')

    const finalUserTokenBalance = await getTokenBalance(user.publicKey)
    const finalVaultBalance = await getTokenBalance(getBondingCurveAddress(), true)

    const expectedFinalBalance = initialUserBalance + Number(solAmount) - feeAmount - tx.meta.fee

    expect(finalUserBalance).to.be.closeTo(expectedFinalBalance, 100)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance - Number(solAmount))
    expect(finalFeeRecipientBalance).to.eq(initialFeeRecipientBalance + feeAmount)
    expect(finalUserTokenBalance.toString()).to.eq((initialUserTokenBalance - tokenAmount).toString())
    expect(finalVaultBalance.toString()).to.eq((initialVaultBalance + tokenAmount).toString())

    expect(fromBN(initialBondingCurve.reserveSol) - fromBN(finalBondingCurve.reserveSol)).to.eq(solAmount)
    expect(fromBN(finalBondingCurve.reserveToken) - fromBN(initialBondingCurve.reserveToken)).to.eq(tokenAmount)
  }

  async function expectWithdraw() {
    const initialMigrationBalance = await provider.connection.getBalance(migrationKeypair.publicKey)
    const initialBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const initialBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')
    const initialMigrationTokenBalance = await getTokenBalance(migrationKeypair.publicKey)

    const tx = await withdraw()

    const finalMigrationBalance = await provider.connection.getBalance(migrationKeypair.publicKey)
    const finalBondingCurveBalance = await provider.connection.getBalance(getBondingCurveAddress())
    const finalBondingCurve = await program.account.bondingCurve.fetch(getBondingCurveAddress(), 'confirmed')
    const finalMigrationTokenBalance = await getTokenBalance(migrationKeypair.publicKey)
    const finalVaultBalance = await getTokenBalance(getBondingCurveAddress(), true)

    expect(finalMigrationBalance).to.be.closeTo(initialMigrationBalance + initialBondingCurve.reserveSol.toNumber() - tx.meta.fee, 100)
    expect(finalBondingCurveBalance).to.eq(initialBondingCurveBalance - initialBondingCurve.reserveSol.toNumber())
    const remainingTokens = tokenSupply - tokenThreshold
    expect(finalMigrationTokenBalance.toString()).to.eq((initialMigrationTokenBalance + remainingTokens).toString())
    expect(finalVaultBalance.toString()).to.eq('0')
    expect(finalBondingCurve.reserveToken.toNumber()).to.eq(0)
    expect(finalBondingCurve.reserveSol.toNumber()).to.eq(0)
  }

  async function buy(solAmount: bigint, minTokenAmount: bigint) {
    const txSignature = await program.methods
      .buy(toBN(solAmount), toBN(minTokenAmount), { partner: partnerPubKey })
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
      .sell(toBN(tokenAmount), toBN(minSolAmount), { partner: partnerPubKey })
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

  async function fetchGlobalConfig() {
    const [globalConfigAddress] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from('global_config')], program.programId)
    return await program.account.globalConfig.fetch(globalConfigAddress, 'confirmed')
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

  async function getTokenBalance(owner: PublicKey, allowOwnerOffCurve = false) {
    const address = getAssociatedTokenAddressSync(mintKeypair.publicKey, owner, allowOwnerOffCurve)
    const accountInfo = await provider.connection.getAccountInfo(address)

    if (accountInfo) {
      const accountBalance = await provider.connection.getTokenAccountBalance(address)
      return BigInt(accountBalance.value.amount)
    } else {
      return 0n
    }
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
