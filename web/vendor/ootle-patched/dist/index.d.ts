import { AllocatableAddressType } from '@tari-project/ootle-ts-bindings';
import { Amount } from '@tari-project/ootle-ts-bindings';
import { ClaimBurnOutputData } from '@tari-project/ootle-ts-bindings';
import { ClaimedOutputTombstoneAddress } from '@tari-project/ootle-ts-bindings';
import { ComponentAddress } from '@tari-project/ootle-ts-bindings';
import { ConfidentialWithdrawProof } from '@tari-project/ootle-ts-bindings';
import { Decision } from '@tari-project/ootle-ts-bindings';
import { ExecuteResult } from '@tari-project/ootle-ts-bindings';
import { FinalizeOutcome } from '@tari-project/ootle-ts-bindings';
import { FinalizeResult } from '@tari-project/ootle-ts-bindings';
import { GetSubstatesRequest } from '@tari-project/ootle-ts-bindings';
import { GetSubstatesResponse } from '@tari-project/ootle-ts-bindings';
import { GetTemplateDefinitionResponse } from '@tari-project/ootle-ts-bindings';
import { IndexerGetSubstateRequest } from '@tari-project/ootle-ts-bindings';
import { IndexerGetSubstateResponse } from '@tari-project/ootle-ts-bindings';
import { IndexerGetTransactionResultResponse } from '@tari-project/ootle-ts-bindings';
import { IndexerSubmitTransactionRequest } from '@tari-project/ootle-ts-bindings';
import { IndexerSubmitTransactionResponse } from '@tari-project/ootle-ts-bindings';
import { IndexerTransactionFinalizedResult } from '@tari-project/ootle-ts-bindings';
import { InputDeclaration } from '@tari-project/ootle-ts-bindings';
import { Instruction } from '@tari-project/ootle-ts-bindings';
import { InstructionArg } from '@tari-project/ootle-ts-bindings';
import { ListRecentTransactionsRequest } from '@tari-project/ootle-ts-bindings';
import { ListRecentTransactionsResponse } from '@tari-project/ootle-ts-bindings';
import { MinotariBurnClaimProof } from '@tari-project/ootle-ts-bindings';
import { NonFungibleAddress } from '@tari-project/ootle-ts-bindings';
import { OutputBody } from '@tari-project/ootle-ts-bindings';
import { PublishedTemplateAddress } from '@tari-project/ootle-ts-bindings';
import { RejectReason } from '@tari-project/ootle-ts-bindings';
import { ResourceAddress } from '@tari-project/ootle-ts-bindings';
import { RistrettoPublicKeyBytes } from '@tari-project/ootle-ts-bindings';
import { StealthTransferStatement as StealthTransferStatement_2 } from '@tari-project/ootle-ts-bindings';
import { SubstateId } from '@tari-project/ootle-ts-bindings';
import { SubstateRequirement } from '@tari-project/ootle-ts-bindings';
import { Transaction } from '@tari-project/ootle-ts-bindings';
import { TransactionEnvelope } from '@tari-project/ootle-ts-bindings';
import { TransactionSignature } from '@tari-project/ootle-ts-bindings';
import { TransactionV1 } from '@tari-project/ootle-ts-bindings';
import { UnsealedTransactionV1 } from '@tari-project/ootle-ts-bindings';
import { UnsignedTransactionV1 } from '@tari-project/ootle-ts-bindings';
import { UtxoAddress } from '@tari-project/ootle-ts-bindings';
import { ValidatorFeePoolAddress } from '@tari-project/ootle-ts-bindings';
import { VaultId } from '@tari-project/ootle-ts-bindings';
import { WorkspaceOffsetId } from '@tari-project/ootle-ts-bindings';

/**
 * Fluent builder for common account component invocations.
 * Mirrors `AccountInvokeBuilder` from the Rust ootle-rs crate.
 *
 * @example
 * ```ts
 * const tx = new AccountInvokeBuilder(network, maxEpoch)
 *   .feeTransactionPayFromComponent(accountAddress, 1000n)
 *   .publicTransfer(accountAddress, resourceAddress, 500n, recipientAddress)
 *   .build();
 * ```
 */
export declare class AccountInvokeBuilder {
    private builder;
    constructor(network: Network | number, maxEpoch: number);
    /**
     * Declares the transaction's substate inputs (e.g. the source account and its
     * vaults) so the indexer resolves their versions before submission.
     */
    withInputs(inputs: SubstateRequirement[]): this;
    /**
     * Adds a fee instruction paying from the account's default vault.
     */
    feeTransactionPayFromComponent(componentAddress: ComponentAddress, maxFee: bigint): this;
    /**
     * Transfers `amount` of `resource` from `sourceAccount` to `destinationAddress`.
     * Mirrors `AccountInvokeBuilder::public_transfer` from ootle-rs.
     */
    publicTransfer(sourceAccount: ComponentAddress, resourceAddress: ResourceAddress, amount: bigint, destinationAddress: string): this;
    /**
     * Publishes a compiled template WASM blob (standard-base64 encoded).
     * Mirrors `AccountInvokeBuilder::publish_template` from ootle-rs.
     *
     * `sourceAccount` is the fee payer; declare it via {@link feeTransactionPayFromComponent}
     * and {@link withInputs}. Pass `workspaceBucket` to capture the new template address
     * for a follow-up instruction.
     */
    publishTemplate(_sourceAccount: ComponentAddress, templateBinaryBase64: string, workspaceBucket?: string): this;
    build(): UnsignedTransactionV1;
}

export { Amount }

/**
 * CBOR-encode an `Amount` (u128) the way the runtime's `minicbor` codec does:
 * a plain CBOR unsigned integer while the value fits the CBOR integer range
 * (`0..=u64::MAX`), and an RFC 8949 tag-2 unsigned bignum (minimal-length
 * big-endian byte string) above it.
 *
 * Wire-breaking against the pre-0.39 `[lo_u64, hi_u64]` digit-array form —
 * templates built against an older `tari_template_lib` cannot decode this.
 *
 * @throws {InvalidArgumentError} if `value` is negative or overflows u128.
 */
export declare function amountLiteral(value: bigint): InstructionArg;

/**
 * Asserts that `bytes` has exactly `length` bytes; otherwise throws with a
 * descriptive message. Returns `bytes` so the assertion can be used inline in a
 * property initialiser or destructuring expression.
 *
 * Message format deliberately mirrors the existing stealth-side inline checks
 * (e.g. `Mask must be 32 bytes, got 31`).
 *
 * @throws {InvalidArgumentError} when the length does not match.
 */
export declare function assertByteLength(bytes: Uint8Array, length: number, name: string): Uint8Array;

/**
 * Standard TypeScript exhaustiveness helper. Use at the bottom of a `switch` over
 * a discriminated union (or any branch the type system has narrowed to `never`)
 * to assert at compile-time that every case is handled — and throw at runtime if
 * an unhandled value sneaks past the type checker.
 */
export declare function assertUnreachable(x: never, hint?: string): never;

/**
 * The post-{@link WalletStealthAuthorizer.prepare} handle.
 *
 * Owns the hydrated spec, the resolved stealth inputs, and the single seal keypair shared
 * across one-time authorizations and the seal signature. Constructed only via
 * {@link WalletStealthAuthorizer.prepare} — there is no way to obtain one without preparing
 * first, so {@link seal} / {@link createAuthorizations} no longer need a `prepared` guard.
 */
export declare class AuthorizedTransfer {
    private readonly wallet;
    private readonly crypto;
    private readonly spec;
    private readonly resolvedInputs;
    private readonly mustSignWithAccountKey;
    /**
     * The single seal keypair, generated once and shared across the one-time spend-key
     * authorizations (which hash the tx with its public key) and the final {@link seal}. Every
     * signature must be over the same tx hash, which depends on this exact seal public key.
     */
    private readonly sealKeypair;
    /** Extra signatures appended via {@link addSignature} before sealing. */
    private readonly extraSignatures;
    /**
     * Memoized one-time spend-key authorizations — see {@link createAuthorizations} for the
     * lifecycle and why memoization (not recomputation) is required.
     */
    private cachedAuthorizations?;
    constructor(params: AuthorizedTransferParams);
    /** The shared seal signer public key (fixed for this transfer's lifetime). */
    getSealPublicKey(): Uint8Array;
    /** The hydrated, post-`prepare` spec (balance proof filled, instruction patched). */
    getSpec(): StealthTransferSpec;
    /**
     * Produce the one-time spend-key authorizations for the stealth inputs (empty for a
     * revealed-only transfer).
     *
     * For each resolved input, picks the owner's signer from the wallet and calls its
     * `addStealthSignature(unsignedJson, publicNonce, sealPublicKey, { crypto })` — which
     * derives the one-time spend scalar via `stealthDhSecret` and signs the tx hash. The
     * secret stays in the signer (never pulled into the transfer).
     *
     * Uses this transfer's shared seal public key ({@link getSealPublicKey}) — the same one
     * {@link seal} uses — so every signature is over the same tx hash. The tx hashed is
     * `spec.unsignedTx` (already resolved by the builder); {@link seal} does not re-resolve,
     * so the hashes match.
     *
     * **Memoized.** The authorizations are computed on the first call and cached; every
     * subsequent call — including the internal one from {@link seal} — returns the *same*
     * array, never re-signing with a fresh random nonce. Calling this before {@link seal}
     * cannot double-count, because {@link seal} reuses the cache. Callers therefore must
     * **not** feed these one-time authorizations to {@link addSignature} — they are
     * auto-included exactly once at seal time.
     *
     * @throws {KeyProviderNotFoundError} if a stealth-input owner has no signer registered.
     * @throws {SignerError} if a stealth-input owner's signer cannot produce one-time
     *   stealth signatures (lacks `addStealthSignature`).
     */
    createAuthorizations(): Promise<TransactionAuthorization[]>;
    /**
     * Sign each resolved stealth input with its owner's one-time spend key (fresh random
     * nonce per signature). Called **once** via {@link createAuthorizations}'s memoization —
     * never directly — so the random-nonce signatures are produced a single time.
     */
    private computeAuthorizations;
    /**
     * Append an extra signature for a **genuine external co-signer** to be included when
     * sealing. The account-key signature is added automatically at {@link seal} unless
     * `mustSignWithAccountKey` is `false`.
     *
     * Do **NOT** pass the per-input one-time spend-key authorizations here — they are
     * produced (memoized) by {@link createAuthorizations} and auto-included by {@link seal}
     * exactly once. Re-adding them via this method would double-count them in the sealed tx,
     * which the engine rejects.
     */
    addSignature(signature: TransactionSignature): this;
    /**
     * Sign and seal the (prepared) transfer into a `TransactionEnvelope`.
     *
     * Composes, over a SINGLE shared seal keypair:
     * - the account-key signature (unless `mustSignWithAccountKey` is `false`);
     * - the per-input **one-time spend-key authorizations** — included **exactly once** per
     *   stealth input via {@link createAuthorizations}'s memoized cache, whether or not the
     *   caller invoked {@link createAuthorizations} first; callers must NOT also re-add them
     *   via {@link addSignature};
     * - any {@link addSignature} extras (e.g. genuine external co-signers).
     *
     * All of these — and the seal signature itself — hash the tx with the same seal public
     * key, so every signature verifies against the same hash. The tx is **not** re-resolved
     * here (the builder already resolved it in `prepare()`); re-resolving could change the
     * hash and invalidate the already-computed one-time authorizations.
     *
     * @throws {KeyProviderNotFoundError} when a stealth-input owner has no signer registered.
     * @throws {SignerError} when a stealth-input signer cannot produce one-time signatures.
     */
    seal(): Promise<TransactionEnvelope>;
}

/**
 * Parameters for the {@link AuthorizedTransfer} constructor. Kept internal — the only
 * construction path is via {@link WalletStealthAuthorizer.prepare}.
 */
declare interface AuthorizedTransferParams {
    wallet: OotleWallet;
    crypto: StealthCryptoProvider;
    spec: StealthTransferSpec;
    resolvedInputs: ResolvedStealthInput[];
    mustSignWithAccountKey: boolean;
    sealKeypair: SealKeypair;
}

/**
 * The balance-proof Schnorr signature `(public_nonce, signature)`. For a
 * fully-revealed transfer this pair is normally omitted on the envelope.
 */
export declare class BalanceProofSignature {
    private readonly _publicNonce;
    private readonly _signature;
    constructor(publicNonce: Uint8Array, signature: Uint8Array);
    /** 32-byte public nonce (defensive copy). */
    get publicNonce(): Uint8Array;
    /** 32-byte signature scalar (defensive copy). */
    get signature(): Uint8Array;
    toJSON(): BalanceProofSignatureJson;
    static fromJSON(json: BalanceProofSignatureJson): BalanceProofSignature;
}

/** Wire shape of a {@link BalanceProofSignature}. */
declare interface BalanceProofSignatureJson {
    public_nonce: string;
    signature: string;
}

/** CBOR-encode a `bool` as a CBOR boolean primitive. */
export declare function boolLiteral(value: boolean): InstructionArg;

/**
 * Assemble a TransactionSignature from a 32-byte public key and a Schnorr
 * `(public_nonce, signature)` pair. Asserts the 32-byte length on all three
 * inputs at the trust boundary so length regressions surface here, not deeper.
 */
export declare function buildTransactionSignature(publicKey: Uint8Array, sig: {
    public_nonce: Uint8Array;
    signature: Uint8Array;
}): TransactionSignature;

/**
 * Internal base for 32-byte stealth-domain carriers (`Mask`, `StealthInput`).
 * Asserts the 32-byte length at construction and defensively copies on the way
 * in; subclasses inherit `toBytes()` / `toHex()` which return fresh copies.
 *
 * Exported for cross-file extension by `StealthInput` in `./statements`; not
 * part of the public package surface (not re-exported from `./types`).
 */
declare abstract class Bytes32 {
    private readonly bytes;
    protected constructor(bytes: Uint8Array, fieldName: string);
    toBytes(): Uint8Array;
    toHex(): string;
}

/** CBOR-encode a `Vec<u8>` as a CBOR byte string. */
export declare function bytesLiteral(value: Uint8Array): InstructionArg;

/**
 * CBOR-encode a `ClaimedOutputTombstoneAddress` as `Tag(136, bytes(32))`.
 * Accepts either the `tombstone_<hex>` form or the bare 64-hex-char tail.
 *
 * @throws {InvalidArgumentError} if the address body is not 32 bytes (64 hex chars).
 */
export declare function claimedOutputTombstoneAddressLiteral(address: ClaimedOutputTombstoneAddress): InstructionArg;

/**
 * @throws {InvalidArgumentError} if `result` carries an unrecognised `final_decision`
 *   variant (an indexer protocol mismatch — defence-in-depth).
 */
export declare function classifyOutcome(result: IndexerTransactionFinalizedResult): {
    outcome: FinalizeOutcome | "Reject";
    reason?: string;
} | null;

/**
 * Extract the 32-byte commitment from a UTXO substate id.
 *
 * A UTXO id has the form `utxo_{resourceHex}_{commitmentHex}`; the commitment is the
 * **trailing** hex segment. Returns `null` if the id is not a UTXO id (wrong prefix,
 * e.g. a component/vault id) or the trailing segment is not exactly 32 bytes of hex.
 *
 * The commitment is **never** in the output body — always derive it from the id.
 *
 * @param substateId - The full substate id string.
 * @returns The 32-byte commitment, or `null` if `substateId` is not a valid UTXO id.
 */
export declare function commitmentOf(substateId: string): Uint8Array | null;

/**
 * The only outcome a `PendingTransaction.watch()` can resolve to: a successful
 * commit. Every non-commit verdict (Reject, FeeIntentCommit, timeout, cancel)
 * throws instead, so the return type is narrowed to this rather than the full
 * {@link TransactionOutcome} union.
 */
export declare interface CommitOutcome {
    outcome: "Commit";
}

/**
 * CBOR-encode a `ComponentAddress` as `Tag(128, bytes(32))`. Accepts either the
 * `component_<hex>` form or the bare 64-hex-char tail.
 *
 * @throws {InvalidArgumentError} if the address body is not 32 bytes (64 hex chars).
 */
export declare function componentAddressLiteral(address: ComponentAddress): InstructionArg;

/**
 * Construct an {@link Output}, applying the conventional defaults and validating
 * the amount.
 *
 * @throws {InvalidArgumentError} if `amount <= 0n`.
 */
export declare function createOutput(init: OutputInit): Output;

/**
 * Raised when the WASM crypto bridge fails (AEAD decryption, balance-proof
 * verification, scalar parsing, …). `context` is a short label identifying which
 * bridge call failed; the original bridge error chains via `cause`.
 */
export declare class CryptoBridgeError extends OotleError {
    readonly context?: string;
    constructor(message: string, options?: ErrorOptions & {
        context?: string;
    });
}

export { Decision }

/**
 * The result of decrypting an owned output via the AEAD path (`unblindOutput`).
 *
 * Maps from the WASM `DecryptedOutputResult { mask: Uint8Array, value: bigint,
 * memo_json: string | undefined }`. Per the verified 0.38 ABI, `memo` is the
 * **JSON-encoded `Memo` string** (`U256` / `Message` / `Bytes` / `PayRefAndBytes`),
 * not raw bytes — callers parse it if needed.
 */
export declare interface DecryptedData {
    /** Recovered output blinding factor. */
    mask: Mask;
    /** Recovered µTari amount. */
    value: bigint;
    /** The JSON-encoded `Memo` string, if present. */
    memo?: string;
}

/**
 * Decrypt an output's encrypted data given its raw commitment + ciphertext bytes.
 *
 * Derives the AEAD key (`deriveAeadKey(viewSecret, senderPublicNonce)`) and unblinds.
 * **Throws** (via `unblindOutput`) when the output is not owned — callers that scan a
 * batch should prefer {@link decryptOwnedUtxo}, which swallows that throw.
 *
 * @param crypto - The crypto seam (real WASM or a fake).
 * @param commitment - The output's 32-byte Pedersen commitment.
 * @param encryptedData - The raw ciphertext bytes.
 * @param options - The sender public nonce, recipient view secret, and `skipMemo` flag.
 * @returns The decrypted value / mask / memo.
 */
export declare function decryptInputData(crypto: StealthCryptoProvider, commitment: Uint8Array, encryptedData: Uint8Array, options: DecryptInputOptions): Promise<DecryptedData>;

/** Inputs to {@link decryptInputData}. All byte fields are raw `Uint8Array`. */
export declare interface DecryptInputOptions {
    /** The output's sender public nonce (the substate body `public_nonce`, as bytes). */
    senderPublicNonce: Uint8Array;
    /** The recipient's 32-byte view secret. */
    viewSecret: Uint8Array;
    /** When `true`, the memo is not decrypted. */
    skipMemo: boolean;
}

/**
 * The recipient owner-read: try to decrypt a fetched UTXO substate with a view secret.
 *
 * Parses the substate (commitment from the id, `public_nonce` + `encrypted_data` from
 * the body), derives the AEAD key, and unblinds. Returns the {@link DecryptedData} for
 * an owned UTXO, or `null` when the substate is not a live stealth UTXO **or** the
 * decrypt throws (the "not ours" signal). This lets a recipient scan many substates in
 * a loop without a try/catch at each call site.
 *
 * @param crypto - The crypto seam (real WASM or a fake).
 * @param viewSecret - The recipient's 32-byte view secret.
 * @param substate - The fetched substate response.
 * @param substateId - The substate id the response was fetched by (source of the commitment).
 * @returns The decrypted output if owned, else `null`.
 */
export declare function decryptOwnedUtxo(crypto: StealthCryptoProvider, viewSecret: Uint8Array, substate: IndexerGetSubstateResponse, substateId: string): Promise<DecryptedData | null>;

/**
 * The validity window {@link resolveMaxEpoch} applies when the caller does not name one.
 * Ten epochs is comfortably longer than a transaction takes to finalize while still
 * letting a stuck transaction die on its own rather than lingering as a resubmittable
 * intent.
 */
export declare const DEFAULT_TRANSACTION_VALIDITY_EPOCHS = 10;

/**
 * Returns a known default indexer URL for the given network.
 * Mirrors `default_indexer_url()` from the Rust ootle-rs crate.
 *
 * @throws {InvalidArgumentError} for networks where no default URL is configured.
 */
export declare function defaultIndexerUrl(network: Network): string;

/** The wallet has no default signer to sign / seal with. */
export declare class DefaultSignerNotSetError extends WalletError {
}

/**
 * Opaque carrier for an output's ciphertext bytes (the AEAD-encrypted value/mask/memo
 * payload). Treated as opaque here: the stealth module never inspects the plaintext
 * structure, only carries the bytes across the JSON boundary.
 */
export declare class EncryptedData {
    private readonly bytes;
    constructor(bytes: Uint8Array);
    /** Parse a hex string into `EncryptedData` (variable length). */
    static fromHex(hex: string): EncryptedData;
    /** Raw ciphertext bytes (defensive copy). */
    toBytes(): Uint8Array;
    /** Hex encoding. */
    toHex(): string;
}

export { ExecuteResult }

/**
 * Fluent builder for common faucet component invocations.
 * Mirrors `FaucetInvokeBuilder` from the Rust ootle-rs crate.
 *
 * @example
 * ```ts
 * const tx = new FaucetInvokeBuilder(network, maxEpoch, faucetAddress)
 *   .feeTransactionPayFromComponent(accountAddress, 1000n)
 *   .takeFaucetFunds(accountAddress, 10_000n)
 *   .build();
 * ```
 */
export declare class FaucetInvokeBuilder {
    private builder;
    private readonly faucetAddress;
    constructor(network: Network | number, maxEpoch: number, faucetAddress: ComponentAddress);
    feeTransactionPayFromComponent(componentAddress: ComponentAddress, maxFee: bigint): this;
    /**
     * Takes `amount` of funds from the faucet and deposits them into `destinationAccount`.
     * Mirrors `FaucetInvokeBuilder::take_faucet_funds` from ootle-rs.
     */
    takeFaucetFunds(destinationAccount: ComponentAddress, amount: bigint): this;
    /**
     * Takes the maximum available funds from the faucet into `destinationAccount`.
     * Mirrors `FaucetInvokeBuilder::take_max_faucet_funds` from ootle-rs.
     */
    takeMaxFaucetFunds(destinationAccount: ComponentAddress): this;
    /**
     * Publishes a template from the faucet component address.
     * Mirrors `FaucetInvokeBuilder::publish_template` from ootle-rs.
     */
    publishTemplate(templateAddress: PublishedTemplateAddress, workspaceBucket?: string): this;
    build(): UnsignedTransactionV1;
}

export { FinalizeOutcome }

export { FinalizeResult }

/**
 * Decodes a hex string into bytes.
 *
 * Strict: rejects odd-length input and any character outside `[0-9a-fA-F]`.
 * Returns an empty `Uint8Array` for an empty input.
 *
 * @throws {InvalidArgumentError} if `hex` has odd length or contains non-hex characters.
 */
export declare function fromHexStr(hex: string): Uint8Array;

/**
 * Faucet / public-stealth convenience: build a **complete** {@link StealthTransferStatement}
 * for a transfer that has no stealth inputs (e.g. a faucet minting confidential outputs, or
 * any revealed → stealth transfer that doesn't need the full {@link StealthTransfer} builder).
 *
 * Generates the outputs statement, uses a zero (`Mask.zero()`) input mask over an empty
 * revealed-only inputs statement, signs the balance proof, and returns a ready-to-embed
 * statement (`balanceProof` filled). The output mask is non-zero (there is ≥1 stealth
 * output), so the proof is real — not the omitted all-zeros case.
 *
 * For multi-step transfers with revealed change / fee, prefer the {@link StealthTransfer}
 * builder + {@link WalletStealthAuthorizer}; this is the one-shot helper.
 *
 * @param crypto - The crypto seam (real WASM or a fake).
 * @param specs - The stealth outputs to create (must be non-empty).
 * @param revealed - The revealed (un-confidential) output amount (0 for fully-stealth).
 * @returns A complete transfer statement.
 * @throws {InvalidArgumentError} if `specs` is empty.
 */
export declare function generateOutputsStatement(crypto: StealthCryptoProvider, specs: Output[], revealed: bigint, revealedReceiver?: Uint8Array): Promise<StealthTransferStatement>;

/**
 * Generate a fresh seal keypair (a thin wrapper over the WASM `generateKeypair`).
 *
 * Exposed so a caller that needs the seal **public key before sealing** can fix the
 * keypair once and thread the same public key through other signatures that hash with
 * it (the stealth one-time authorizations — see {@link signTransaction}'s `sealKeypair`
 * parameter). Keeps `@tari-project/ootle-wasm` out of the `stealth/` module.
 */
export declare function generateSealKeypair(): SealKeypair;

export { GetSubstatesRequest }

export { GetSubstatesResponse }

export { GetTemplateDefinitionResponse }

/**
 * Fetch `account` and return the list of vault ids it references (depth-first,
 * unique). Returns an empty array if the component does not exist or holds no
 * vaults.
 */
export declare function getVaultIdsForAccount(provider: Provider, account: ComponentAddress): Promise<string[]>;

/**
 * Raised when the indexer transport fails or returns a non-success response.
 *
 * `status` is the HTTP status if the request reached the indexer (else `undefined`,
 * e.g. a connection-layer failure). `body` is the raw response body when
 * available, and `url` is the request URL. The original transport error chains via
 * `cause`.
 */
export declare class IndexerClientError extends OotleError {
    readonly status?: number;
    readonly body?: string;
    readonly url?: string;
    constructor(message: string, options?: ErrorOptions & {
        status?: number;
        body?: string;
        url?: string;
    });
}

export { IndexerGetSubstateRequest }

export { IndexerGetSubstateResponse }

export { IndexerGetTransactionResultResponse }

export { IndexerSubmitTransactionRequest }

export { IndexerSubmitTransactionResponse }

export { IndexerTransactionFinalizedResult }

export { Instruction }

export { InstructionArg }

/**
 * CBOR-encode a plain integer (Rust `u8`…`u128` / `i8`…`i128`) as a bare CBOR
 * integer. Distinct from {@link amountLiteral} only above the CBOR integer
 * range, where an `Amount` becomes a tag-2 bignum and this throws instead.
 *
 * @throws {InvalidArgumentError} if the magnitude exceeds the 64-bit CBOR
 *   integer range (128-bit bignum encoding is not supported).
 */
export declare function intLiteral(value: bigint): InstructionArg;

/** Raised when builder / helper inputs fail TS-side validation or state-machine checks. */
export declare class InvalidArgumentError extends OotleError {
}

/**
 * Type guard for the native `StealthTransfer` {@link Instruction} variant. Used by the
 * authorizer to locate the single stealth instruction it must patch.
 */
export declare function isStealthTransferInstruction(instruction: Instruction): instruction is StealthTransferInstruction;

/**
 * Walk the JSON-rendered `tari_bor::Value` of a component's state and yield every
 * 32-byte payload of a `Tag(VAULT_ID, Bytes(..))` node — i.e. every vault id the
 * component references. Depth-first, unique by hex payload.
 *
 * The engine emits values that don't map cleanly to JSON via a `{"@cbor": …}`
 * sentinel object; this walker handles `tag`, `map`, and `bytes` sentinels and
 * recurses through plain text-keyed maps and arrays.
 */
export declare function iterVaultIdsInState(value: unknown): Generator<string>;

/**
 * The wallet has no signer registered for the given address.
 *
 * `address` is intentionally typed as `unknown`: the wallet may register key
 * providers under any keying shape (a `ComponentAddress`, a `ResourceAddress`, …),
 * and the typed error should not pollute the consumer's downstream signature.
 */
export declare class KeyProviderNotFoundError extends WalletError {
    readonly address: unknown;
    constructor(message: string, options: ErrorOptions & {
        address: unknown;
    });
}

/**
 * CBOR-encode a value into an `InstructionArg::Literal` by its JavaScript type:
 * `bigint` → `Amount`, `string` → CBOR text, `boolean` → CBOR bool,
 * `Uint8Array` → CBOR byte string. For tagged on-chain addresses use
 * {@link resourceAddressLiteral} / {@link componentAddressLiteral} instead — a
 * raw address string would be encoded as plain text, not a tagged object key.
 *
 * @throws {InvalidArgumentError} if `value` is not one of the supported types.
 */
export declare function literalArg(value: bigint | string | boolean | Uint8Array): InstructionArg;

/**
 * A 32-byte blinding factor (Pedersen-commitment mask).
 *
 * Use {@link Mask.zero} for the faucet / revealed-only path (an all-zero scalar).
 */
export declare class Mask extends Bytes32 {
    constructor(bytes: Uint8Array);
    /** All-zero 32-byte mask, for the faucet / revealed-only path. */
    static zero(): Mask;
    /** Wrap raw 32 bytes into a `Mask` (validates length, defensive copy in the ctor). */
    static fromBytes(bytes: Uint8Array): Mask;
    /** Parse a 64-char hex string into a `Mask` (validates length). */
    static fromHex(hex: string): Mask;
}

/**
 * The longest validity window any network accepts, in epochs
 * (`ConsensusConstants::max_transaction_validity_epochs`, ~30 days). A transaction whose
 * `max_epoch` sits further ahead of the current epoch than this is aborted with
 * `AbortReason::ValidityWindowTooLong`.
 */
export declare const MAX_TRANSACTION_VALIDITY_EPOCHS = 2160;

/**
 * CBOR-encode a `Metadata` map as `Tag(129, Map<text, text>)`. Keys are emitted
 * sorted to match the runtime's `BTreeMap` ordering.
 */
export declare function metadataLiteral(entries: Record<string, string> | Map<string, string>): InstructionArg;

/**
 * Encodes a µTari amount as a BOR-CBOR-encoded hex `Literal` instruction argument.
 *
 * Delegates to {@link amountLiteral}: the runtime's `InstructionArg::Literal` carries
 * a hex string whose bytes are a `tari_bor::encode(value)` CBOR payload, **not** the
 * decimal-string form. Keeping the public type as `bigint` preserves precision for
 * values above `Number.MAX_SAFE_INTEGER`.
 *
 * @throws {InvalidArgumentError} if `amount` is negative or overflows u128.
 */
export declare function microTariLiteral(amount: bigint): InstructionArg;

/**
 * Canonical µTari → decimal-string encoding used wherever the bindings expect a
 * string-encoded amount on the wire (e.g. structural `toJSON()` views of stealth
 * statements). **Not** the BOR-CBOR `Literal` form — use {@link microTariLiteral}
 * / {@link amountLiteral} for instruction arguments.
 *
 * @throws {InvalidArgumentError} if `amount` is negative.
 */
export declare function microTariString(amount: bigint): string;

/**
 * A NamedArg is either:
 * - `{ Workspace: string }` — a named workspace reference resolved by the builder to a numeric ID
 * - `InstructionArg` — a fully-formed `{ Workspace: WorkspaceOffsetId }` or `{ Literal: string }`
 */
export declare type NamedArg = {
    Workspace: string;
} | InstructionArg;

/**
 * Tari network identifiers. Values match the Rust `Network` byte representation.
 */
export declare enum Network {
    MainNet = 0,
    StageNet = 1,
    NextNet = 2,
    LocalNet = 16,
    Igor = 36,
    Esmeralda = 38
}

/**
 * CBOR-encode a `NonFungibleAddress` as `Tag(130, [ResourceAddress, NonFungibleId])`.
 * The inner pair is minicbor's struct-as-array layout; the `NonFungibleId` enum
 * is its two-element `[variant_index, [field]]` form.
 *
 * @throws {InvalidArgumentError} if the resource address or id payload is malformed.
 */
export declare function nonFungibleAddressLiteral(address: NonFungibleAddress): InstructionArg;

/** Base class for every exception thrown by the Ootle SDK. */
export declare abstract class OotleError extends Error {
    constructor(message: string, options?: ErrorOptions);
}

/**
 * A wallet that manages multiple key providers (one per component address) and
 * can sign transactions on behalf of any registered signer.
 *
 * Mirrors `OotleWallet` from the Rust ootle-rs crate.
 *
 * @example
 * ```ts
 * const wallet = new OotleWallet();
 * wallet.registerKeyProvider(myAddress, mySecretKeyWallet);
 * wallet.setDefaultSigner(myAddress);
 *
 * const signed = await wallet.authorizeTransaction(unsignedTx);
 * ```
 */
export declare class OotleWallet implements Signer {
    private keyProviders;
    private defaultSignerAddress;
    constructor();
    /**
     * Registers a key provider (a `Signer`) for the given component address.
     *
     * Stealth capabilities (`getViewSecret`/`addStealthSignature`) are optional methods on
     * `Signer` (see {@link Signer}); the stealth spend authorizer uses them when present.
     */
    registerKeyProvider(address: string, provider: Signer): this;
    /**
     * Sets the address used when `signTransaction` is called without specifying a signer.
     *
     * @throws {KeyProviderNotFoundError} when no key provider has been registered for
     *   `address`.
     */
    setDefaultSigner(address: string): this;
    /**
     * Returns the default signer address, or throws if none is set.
     *
     * @throws {DefaultSignerNotSetError} when no default signer is configured.
     */
    getAddress(): Promise<string>;
    /**
     * @throws {DefaultSignerNotSetError} when no default signer is configured.
     * @throws {KeyProviderNotFoundError} when the default address has no registered provider.
     */
    getPublicKey(): Promise<Uint8Array>;
    /**
     * Signs using the default signer.
     *
     * @throws {DefaultSignerNotSetError} when no default signer is configured.
     * @throws {KeyProviderNotFoundError} when the default address has no registered provider.
     */
    signTransaction(unsignedTx: UnsignedTransactionV1, sealPublicKey: Uint8Array): Promise<TransactionSignature[]>;
    /**
     * Generates `TransactionAuthorization` (signatures) for a specific registered signer.
     * Mirrors `OotleWallet::authorize_transaction` from ootle-rs.
     *
     * @throws {KeyProviderNotFoundError} when no provider is registered for `signerAddress`.
     */
    authorizeTransaction(signerAddress: string, unsignedTx: UnsignedTransactionV1, sealPublicKey: Uint8Array): Promise<TransactionAuthorization>;
    /**
     * Collects authorizations from all registered key providers.
     * Useful when a transaction requires multiple signers.
     */
    authorizeTransactionAll(unsignedTx: UnsignedTransactionV1, sealPublicKey: Uint8Array): Promise<TransactionAuthorization[]>;
    /**
     * Returns the key provider for a specific address, if registered.
     */
    getKeyProvider(address: string): Signer | undefined;
    /**
     * Returns all registered signer addresses.
     */
    getSignerAddresses(): string[];
    private getSignerOrThrow;
    private requireKeyProvider;
}

/** Raised when an in-flight operation was cancelled by the caller. */
export declare class OperationCancelledError extends OotleError {
}

/**
 * A stealth output to create.
 *
 * Use {@link createOutput} to construct one with the conventional defaults
 * (`payTo = { StealthPublicKey: {} }`, `minimumValuePromise = 0n`) and
 * validation (rejects `amount <= 0n`).
 */
export declare interface Output {
    /** Destination account address (a string component/account address). */
    destination: string;
    /** µTari amount to send (must be `> 0n`). */
    amount: bigint;
    /** Resource being transferred. */
    resourceAddress: ResourceAddress;
    /** Resource view key — set only for resources with a viewable balance. */
    resourceViewKey?: Uint8Array;
    /** Optional structured memo attached to the output. */
    memo?: object;
    /** Spend condition for the output; defaults to `{ StealthPublicKey: {} }`. */
    payTo: object;
    /** Minimum value promise (range-proof lower bound); defaults to `0n`. */
    minimumValuePromise: bigint;
}

/** Fields callers supply to {@link createOutput}; `payTo` and `minimumValuePromise` are defaulted. */
export declare interface OutputInit {
    destination: string;
    amount: bigint;
    resourceAddress: ResourceAddress;
    resourceViewKey?: Uint8Array;
    memo?: object;
    payTo?: object;
    minimumValuePromise?: bigint;
}

/** A parsed, spendable UTXO: its commitment (from the id) plus the on-chain output body. */
export declare interface ParsedUtxo {
    /** 32-byte Pedersen commitment, derived from the substate id via {@link commitmentOf}. */
    commitment: Uint8Array;
    /** The on-chain output body (`public_nonce`, `encrypted_data`, ...). */
    body: OutputBody;
}

/**
 * A parsed workspace key string into an object with name and optional offset.
 *
 * Examples:
 *   "bucket"   -> { name: "bucket", offset: null }
 *   "bucket.0" -> { name: "bucket", offset: 0 }
 */
export declare interface ParsedWorkspaceKey {
    name: string;
    offset: number | null;
}

/**
 * Parse a fetched substate into a {@link ParsedUtxo}, or `null` when it is not a
 * live, spendable stealth UTXO.
 *
 * Returns `null` when:
 * - the substate is not the `Utxo` arm of {@link SubstateValue} (e.g. a component/vault),
 * - the UTXO has been spent (`output === null`),
 * - the UTXO is frozen (`is_frozen === true`),
 * - or the substate id does not yield a valid 32-byte commitment.
 *
 * @param substate - The fetched substate response.
 * @param substateId - The substate id the response was fetched by (source of the commitment).
 */
export declare function parseSubstateUtxo(substate: IndexerGetSubstateResponse, substateId: string): ParsedUtxo | null;

/**
 * Parses a workspace key string, supporting dot-notation offsets.
 *
 * @example
 *   parseWorkspaceStringKey("bucket")   // { name: "bucket", offset: null }
 *   parseWorkspaceStringKey("bucket.0") // { name: "bucket", offset: 0 }
 *   parseWorkspaceStringKey("bucket.1") // { name: "bucket", offset: 1 }
 *
 * @throws {InvalidArgumentError} if the key contains more than one dot, or if the
 *   suffix after the dot is empty / non-numeric / negative.
 */
export declare function parseWorkspaceStringKey(key: string): ParsedWorkspaceKey;

/**
 * Patch the single stealth instruction in `unsignedTx` with a (hydrated) statement.
 *
 * Locates the sole `StealthTransfer` instruction (throws if there is not exactly one) and
 * replaces its `statement` field with the byte-exact compact JSON of `statement` (via the
 * single encoding seam in `instruction.ts`). Returns a new `UnsignedTransactionV1` — the
 * input is not mutated.
 *
 * @throws {InvalidArgumentError} when there is no StealthTransfer instruction (not a
 *   stealth tx) or more than one (malformed).
 */
export declare function patchStealthStatement(unsignedTx: UnsignedTransactionV1, statement: StealthTransferStatement): UnsignedTransactionV1;

/**
 * A Provider reads chain state and submits transactions. It has no signing capability.
 * The canonical implementation is IndexerProvider, which talks to the indexer REST API.
 */
export declare interface Provider {
    /** Returns the network this provider is connected to. */
    network(): Network;
    /**
     * Returns the epoch the network is currently on.
     *
     * Every transaction carries a mandatory `max_epoch`, capped at
     * `MAX_TRANSACTION_VALIDITY_EPOCHS` past this value, so a builder needs the chain tip
     * before it can be constructed: `TransactionBuilder.new(network, await
     * provider.getCurrentEpoch() + 10)`.
     */
    getCurrentEpoch(): Promise<number>;
    /** Fetches a single substate by ID and optional version. */
    getSubstate(substateId: string, version?: number | null): Promise<IndexerGetSubstateResponse>;
    /**
     * Fetches a stealth UTXO substate by resource address + 32-byte commitment.
     *
     * The provider owns the `utxo_{resourceHex}_{commitmentHex}` id format; callers pass
     * the resource and commitment and never string the id themselves. Returns `null` when
     * the UTXO does not exist (already spent / never created), instead of throwing.
     */
    getStealthUtxo(resourceAddress: string, commitment: Uint8Array): Promise<IndexerGetSubstateResponse | null>;
    /** Fetches multiple substates by ID in a single request. */
    fetchSubstates(requests: SubstateId[]): Promise<GetSubstatesResponse>;
    /** Returns the ABI definition for a published template. */
    getTemplateDefinition(templateAddress: string): Promise<GetTemplateDefinitionResponse>;
    /**
     * Submits a BOR+base64-encoded transaction envelope to the network.
     * Encoding is performed by `sealTransaction` in `transaction.ts`.
     */
    submitTransaction(envelope: TransactionEnvelope): Promise<IndexerSubmitTransactionResponse>;
    /** Polls for the result of a previously submitted transaction. */
    getTransactionResult(transactionId: string): Promise<IndexerGetTransactionResultResponse>;
    /**
     * Resolves unversioned inputs by fetching their current version from the indexer.
     * Returns the same list with `version` filled in for any entry that had `version: null`.
     */
    resolveInputs(inputs: SubstateRequirement[]): Promise<SubstateRequirement[]>;
    /** Lists recent transactions. */
    listRecentTransactions(params: ListRecentTransactionsRequest): Promise<ListRecentTransactionsResponse>;
}

/**
 * CBOR-encode a `RistrettoPublicKeyBytes` as a 32-byte CBOR byte string. A
 * compressed Ristretto point is *not* a tagged value — it is a bare byte string,
 * the same shape {@link bytesLiteral} produces. Accepts a 64-hex-char string or
 * a 32-byte `Uint8Array`; this wrapper exists so the public-key intent and the
 * length check are explicit at the call site.
 *
 * @throws {InvalidArgumentError} if the key is not exactly 32 bytes.
 */
export declare function publicKeyLiteral(value: RistrettoPublicKeyBytes | Uint8Array): InstructionArg;

/**
 * A stealth input resolved during {@link WalletStealthAuthorizer.prepare}: the input being
 * spent, its owner address (the one-time signer), the recovered blinding mask, and the
 * sender public nonce read from the fetched UTXO body (the DH counterparty for one-time
 * signing). Insertion-ordered, matching `spec.inputs`.
 */
declare interface ResolvedStealthInput {
    ownerAddr: string;
    input: StealthInput;
    mask: Mask;
    /** The fetched UTXO's sender public nonce (`OutputBody.public_nonce`), raw bytes. */
    publicNonce: Uint8Array;
}

/**
 * Reads the chain tip and returns the `max_epoch` a transaction built now should carry:
 * `currentEpoch + leadEpochs`.
 *
 * ```ts
 * const builder = TransactionBuilder.new(provider.network(), await resolveMaxEpoch(provider));
 * ```
 *
 * @throws {InvalidArgumentError} if `leadEpochs` is not a positive integer, or exceeds
 *   {@link MAX_TRANSACTION_VALIDITY_EPOCHS} (which the network would reject with
 *   `AbortReason::ValidityWindowTooLong`).
 */
export declare function resolveMaxEpoch(provider: Provider, leadEpochs?: number): Promise<number>;

/**
 * Resolves unversioned inputs in the unsigned transaction by fetching their current
 * version from the provider.
 */
export declare function resolveTransaction(provider: Provider, unsignedTx: UnsignedTransactionV1): Promise<UnsignedTransactionV1>;

/**
 * CBOR-encode a `ResourceAddress` as `Tag(131, bytes(32))`. Accepts either the
 * `resource_<hex>` form or the bare 64-hex-char tail.
 *
 * @throws {InvalidArgumentError} if the address body is not 32 bytes (64 hex chars).
 */
export declare function resourceAddressLiteral(address: ResourceAddress): InstructionArg;

/**
 * A seal keypair: the throwaway key the seal signature is produced with.
 *
 * Both fields are expected to be exactly 32 bytes. The length invariant is
 * enforced at the trust boundary (in {@link signTransaction}) rather than via
 * a branded type — see the README scope decision on asserted-`Uint8Array` as
 * the default for non-stealth 32-byte values.
 */
export declare interface SealKeypair {
    secret_key: Uint8Array;
    public_key: Uint8Array;
}

/**
 * BOR-encodes a {@link SignedTransaction} into a TransactionEnvelope.
 *
 * Encodes the byte-exact `sealedJson` directly (never the parsed `transaction` view), so
 * u64 amounts above 2^53 are not corrupted by a `JSON.parse` → `JSON.stringify` round-trip.
 */
export declare function sealTransaction(signed: SignedTransaction): TransactionEnvelope;

/**
 * Like `sendTransaction` but sets `dry_run = true` on the transaction before
 * submitting, so the network simulates execution without committing state.
 */
export declare function sendDryRun(provider: Provider, signers: Signer | Signer[], unsignedTx: UnsignedTransactionV1, watchOpts?: WatchOptions): Promise<IndexerGetTransactionResultResponse>;

/**
 * All-in-one convenience function: resolve → sign → encode → submit → watch.
 */
export declare function sendTransaction(provider: Provider, signers: Signer | Signer[], unsignedTx: UnsignedTransactionV1, watchOpts?: WatchOptions): Promise<IndexerGetTransactionResultResponse>;

/**
 * Serialize an unsigned transaction to the JSON string handed to WASM (`addTransactionSigner`,
 * `sealTransaction`) and to one-time stealth-signature hashing.
 *
 * Identical to `JSON.stringify(unsignedTx)` for any fragment-free transaction — so existing
 * transaction hashes do not shift — but a stealth `statement` is carried as a
 * {@link RawJsonFragment} whose byte-exact `toCompactJson()` string must survive verbatim. Its
 * u64 amounts are bare JSON numbers exceeding 2^53; `JSON.stringify` cannot emit them
 * losslessly. We therefore stringify each carrier as a unique placeholder, then splice the raw
 * fragment in place of the quoted placeholder, never round-tripping the amounts through a JS
 * number.
 *
 * Any `bigint` field (e.g. a large `nonce`) is emitted as a decimal *string*, matching the
 * Tari clients' wire encoding: every 64-bit field on these APIs accepts a string as well as a
 * number, and a string is the only lossless encoding above `Number.MAX_SAFE_INTEGER`. Plain
 * `JSON.stringify` throws on a `bigint`, and the global `BigInt.prototype.toJSON` patch the
 * client packages used to install was removed in 0.39.
 */
export declare function serializeUnsignedTx(unsignedTx: UnsignedTransactionV1): string;

/**
 * Sign the balance proof over an inputs + outputs statement pair.
 *
 * A transfer with **no stealth inputs** uses `inputMask = Mask.zero()`; a
 * **fully-revealed** transfer omits the balance proof entirely (not called here).
 *
 * @returns The `(public_nonce, signature)` balance-proof signature.
 */
export declare function signBalanceProof(crypto: StealthCryptoProvider, inputMask: Mask, outputMask: Mask, inputsStatement: StealthInputsStatement, outputsStatement: StealthOutputsStatement): Promise<BalanceProofSignature>;

/**
 * A signed transaction produced by {@link signTransaction}, ready to be sealed.
 *
 * Carries the byte-exact `sealedJson` string emitted by WASM **alongside** a parsed
 * {@link Transaction} view. The two are intentionally separate:
 *
 * - `sealedJson` is the **canonical artifact**. It preserves u64 amounts that exceed
 *   `Number.MAX_SAFE_INTEGER` (e.g. a confidential output's `minimum_value_promise`),
 *   which the engine emits as bare JSON numbers. {@link sealTransaction} BOR-encodes
 *   this string directly — it never re-stringifies the parsed object.
 * - `transaction` is a **convenience view for inspection only**. It is the result of
 *   `JSON.parse(sealedJson)`, so any bare integer above 2^53 has already been rounded.
 *   Re-serialising it (`JSON.stringify`) and submitting that is lossy — always seal via
 *   `sealedJson`.
 */
export declare interface SignedTransaction {
    /** The byte-exact sealed-transaction JSON from WASM — the canonical bytes to BOR-encode. */
    readonly sealedJson: string;
    /**
     * Parsed view of {@link sealedJson} for inspection. Lossy for u64 amounts > 2^53 — do
     * NOT re-serialise this for submission; seal via {@link sealedJson} instead.
     */
    readonly transaction: Transaction;
}

/**
 * A Signer is responsible only for signing. It has no read or submit capability.
 * Implementations include SecretKeyWallet (local WASM signing) and WalletDaemonSigner (remote daemon).
 */
export declare interface Signer {
    /** Returns the component address derived from this signer's public key. */
    getAddress(): Promise<string>;
    /** Returns the raw public key bytes for this signer. */
    getPublicKey(): Promise<Uint8Array>;
    /**
     * Signs the given unsigned transaction and returns the collected signatures.
     *
     * `sealPublicKey` is mixed into the transaction hash
     * (`hashUnsignedTransaction(JSON.stringify(tx), sealPublicKey)`) so every signature in the
     * final envelope verifies against the SAME hash — the engine's seal verification enforces
     * this. Implementations MUST hash with the supplied `sealPublicKey`, not their own.
     */
    signTransaction(transaction: UnsignedTransactionV1, sealPublicKey: Uint8Array): Promise<TransactionSignature[]>;
    /**
     * Returns the view-only secret for stealth scanning/spending, if this signer holds one.
     *
     * **Optional** — a signer may not hold a view secret (e.g. `EphemeralKeySigner` has no
     * view key; `WalletDaemonSigner` keeps it server-side). The spend authorizer treats this
     * as a fallback: it takes the view secret explicitly from the transfer spec and only
     * calls this when the spec does not carry one.
     */
    getViewSecret?(): Promise<Uint8Array>;
    /**
     * Produces a one-time spend-key signature for a stealth input.
     *
     * The signer derives the one-time spend scalar (`c + k`) for the owned stealth UTXO via
     * `ctx.crypto.stealthDhSecret(...)` and signs the transaction hash with it.
     *
     * **Optional** — only signers that hold the owner secret (e.g. `SecretKeyWallet`) can
     * implement this. Daemon-delegated stealth is server-side and out of scope here.
     *
     * @param unsignedJson - The (compact) JSON of the unsigned transaction to hash + sign.
     * @param publicNonce - The stealth output's sender public nonce (the DH counterparty).
     * @param sealPublicKey - The seal signer's public key, mixed into the transaction hash
     *   (mirrors the `hashUnsignedTransaction` arg used by {@link Signer.signTransaction}).
     * @param ctx - Injected crypto seam, so the signer never imports WASM directly.
     */
    addStealthSignature?(unsignedJson: string, publicNonce: Uint8Array, sealPublicKey: Uint8Array, ctx: {
        crypto: SignerStealthCrypto;
    }): Promise<TransactionSignature>;
}

/** Raised when a {@link Signer} fails to sign, seal, or expose required material. */
export declare class SignerError extends OotleError {
}

/**
 * The exact subset of `StealthCryptoProvider` that {@link Signer.addStealthSignature} needs.
 *
 * Defined here alongside `Signer` so the stealth-agnostic core never depends on the stealth
 * module's full surface. The wider `StealthCryptoProvider` is structurally a supertype, so
 * `WasmStealthCrypto` and `FakeStealthCrypto` flow through as-is.
 */
export declare interface SignerStealthCrypto {
    stealthDhSecret(networkByte: number, ownerSecret: Uint8Array, publicNonce: Uint8Array): Promise<Uint8Array>;
}

/**
 * Collects signatures from all provided signers and assembles a signed transaction.
 *
 * Returns a {@link SignedTransaction} carrying the byte-exact `sealedJson` (the canonical
 * bytes {@link sealTransaction} BOR-encodes) plus a parsed `transaction` view for
 * inspection. The sealed JSON is **not** round-tripped through `JSON.parse`/`JSON.stringify`
 * on its way to the envelope, so u64 amounts above 2^53 (e.g. a confidential output's
 * `minimum_value_promise`) survive byte-exact.
 *
 * @param sealKeypair - Optional pre-generated seal keypair. When omitted, a fresh one is
 *   generated internally (the default for the plain transaction flow). The stealth spend
 *   authorizer passes one so the **same** seal public key flows into its one-time
 *   spend-key authorizations (which hash the tx with the seal public key) and into this
 *   final seal — otherwise those signatures would be over a different hash and fail to
 *   verify.
 */
export declare function signTransaction(signers: Signer[], unsignedTx: UnsignedTransactionV1, sealKeypair?: SealKeypair): Promise<SignedTransaction>;

/**
 * Carry a {@link StealthTransferStatement} into an instruction as a byte-exact raw JSON
 * fragment.
 *
 * The statement's u64 amounts are bare JSON numbers that routinely exceed 2^53; `JSON.parse`
 * would round them and break the signed proofs. We therefore embed the canonical
 * {@link StealthTransferStatement.toCompactJson} string verbatim under {@link RAW_JSON_FRAGMENT}
 * and let {@link serializeUnsignedTx} splice it into the serialized transaction at signing /
 * sealing / hashing time — never round-tripping it through a JS number. The engine still
 * deserialises `statement` as a struct (not a string); the splice produces exactly that.
 *
 * Nothing reads the statement object structurally after it is set (the serializers stringify
 * it wholesale and {@link patchStealthStatement} replaces the whole field), so the documented
 * cast to the binding's structured type is sound.
 */
export declare function statementAsWire(statement: StealthTransferStatement): StealthTransferStatement_2;

/**
 * The single seam that hides all `@tari-project/ootle-wasm` crypto behind a
 * typed, byte/bigint interface returning the SDK's domain types.
 *
 * Every higher layer depends on **this interface**, never on raw WASM, so
 * tests can inject a {@link FakeStealthCrypto fake}. The only real
 * implementation is {@link WasmStealthCrypto}.
 *
 * All methods are **async even though the WASM is synchronous** to leave room
 * for a future off-thread / worker-backed provider without churning call sites.
 */
export declare interface StealthCryptoProvider {
    /**
     * Build the outputs (sender) side of a transfer: one witness per spec, aggregated
     * into a canonical WASM outputs-statement plus the summed output mask.
     *
     * @param specs - The outputs to create (incl. change).
     * @param revealedOutputAmount - The un-confidential (revealed) µTari output amount.
     * @param revealedReceiver - The 32-byte public key allowed to take the revealed output
     *   (tari-ootle#2645: the engine requires its badge in the transaction's auth scope). Required
     *   when `revealedOutputAmount > 0`, ignored otherwise.
     * @returns The WASM-produced {@link StealthOutputsStatement} and the aggregated
     *   `outputMask` for the balance proof.
     */
    generateOutputsStatement(specs: Output[], revealedOutputAmount: bigint, revealedReceiver?: Uint8Array): Promise<{
        statement: StealthOutputsStatement;
        outputMask: Mask;
    }>;
    /**
     * Build the inputs (spend) side of a transfer as canonical WASM wire JSON.
     *
     * @param inputs - The stealth inputs being spent (empty for a revealed-only spend).
     * @param revealedAmount - The un-confidential (revealed) µTari input amount.
     * @returns A {@link StealthInputsStatement} carrying the WASM-produced `statementJson`.
     */
    buildInputsStatement(inputs: StealthInput[], revealedAmount: bigint): Promise<StealthInputsStatement>;
    /**
     * Sign the balance proof over the two statements' canonical wire JSONs.
     *
     * A transfer with **no stealth inputs** passes `inputMask = Mask.zero()`.
     *
     * @returns The `(public_nonce, signature)` balance-proof signature.
     */
    generateBalanceProofSignature(inputMask: Mask, outputMask: Mask, inputsStatementJson: string, outputsStatementJson: string): Promise<BalanceProofSignature>;
    /**
     * Optional client-side pre-flight check of a balance-proof signature. The
     * engine is authoritative at submission — implement as a cheap debug aid only.
     */
    validateBalanceProofSignature?(proof: BalanceProofSignature, inputsStatementJson: string, outputsStatementJson: string): Promise<boolean>;
    /**
     * Derive the 32-byte AEAD encryption key for an output's encrypted data via DH+KDF.
     *
     * - Receivers: `(viewSecret, sender_public_nonce)`.
     * - Senders: `(sender_secret_nonce, recipient_view_pub)`.
     *
     * Split from {@link unblindOutput} to mirror the WASM (`encryptedDataDhKdfAead` then
     * `unblindOutput`).
     */
    deriveAeadKey(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array>;
    /**
     * Decrypt an owned output using a precomputed AEAD key (from {@link deriveAeadKey}).
     *
     * **Throws** on AEAD failure / commitment mismatch — i.e. the output is *not owned*.
     * The receive helper catches this to mean "skip this UTXO".
     *
     * @param commitment - The output's 32-byte Pedersen commitment (from its substate id).
     * @param encryptedData - The raw ciphertext bytes.
     * @param aeadKey - The 32-byte AEAD key from {@link deriveAeadKey}.
     * @param skipMemo - When `true`, the memo is not decrypted.
     */
    unblindOutput(commitment: Uint8Array, encryptedData: Uint8Array, aeadKey: Uint8Array, skipMemo: boolean): Promise<DecryptedData>;
    /**
     * Aggregate input commitment masks into a single scalar. `masks` must be
     * non-empty; the revealed-only case (no stealth inputs) must short-circuit
     * to `Mask.zero()` at the caller instead of calling this method.
     */
    aggregateInputMasks(masks: Mask[]): Promise<Mask>;
    /**
     * Derive the one-time stealth spend scalar (`c + k`) via DH for an owned stealth UTXO.
     *
     * @param networkByte - The network byte (see `Network`).
     * @param ownerSecret - The owner's secret key.
     * @param publicNonce - The output's sender public nonce.
     * @returns The 32-byte spend scalar.
     */
    stealthDhSecret(networkByte: number, ownerSecret: Uint8Array, publicNonce: Uint8Array): Promise<Uint8Array>;
    /**
     * Structurally validate a complete transfer envelope (balance proof filled). **Throws**
     * on invalid. This is a client pre-flight (`view_key = null`); the engine is
     * authoritative for viewable-resource validation at submission.
     */
    validateTransfer(statement: StealthTransferStatement): Promise<void>;
}

/**
 * A stealth input being spent, identified by its 32-byte Pedersen commitment.
 */
export declare class StealthInput extends Bytes32 {
    constructor(commitment: Uint8Array);
    /** 32-byte commitment (defensive copy). */
    get commitment(): Uint8Array;
    toJSON(): StealthInputJson;
    static fromJSON(json: StealthInputJson): StealthInput;
}

/** Wire shape of a {@link StealthInput}. */
declare interface StealthInputJson {
    commitment: string;
}

/**
 * The inputs side of a stealth transfer: the commitments being spent plus the
 * revealed (un-confidential) input amount.
 *
 * **The signed/wire JSON is produced by WASM**, not hand-rolled. This type
 * carries `(inputs, revealedAmount)` plus an optional cached `statementJson`
 * (the WASM-produced wire string). Its `toJSON()` is a **debug/structural**
 * view only — it is NOT the signed wire payload; the crypto seam fills and
 * reads `statementJson` for that.
 */
export declare class StealthInputsStatement {
    readonly inputs: StealthInput[];
    readonly revealedAmount: bigint;
    /** Cached WASM-produced wire JSON (the canonical signed payload), once computed. */
    statementJson?: string;
    constructor(inputs: StealthInput[], revealedAmount: bigint, statementJson?: string);
    /** Revealed-only inputs statement (no confidential inputs). */
    static revealedOnly(amount: bigint): StealthInputsStatement;
    /**
     * Structural view (NOT the signed wire payload — see class docs). Amounts are
     * decimal strings to keep `bigint` out of JSON.
     */
    toJSON(): {
        inputs: StealthInputJson[];
        revealed_amount: string;
    };
    static fromJSON(json: {
        inputs: StealthInputJson[];
        revealed_amount: string;
    }): StealthInputsStatement;
}

/**
 * The outputs side of a stealth transfer.
 *
 * Carries the **WASM-produced** wire payload verbatim. The internal field
 * names of that JSON are owned by the engine and are not modelled here.
 */
export declare class StealthOutputsStatement {
    /** The canonical, WASM-produced outputs-statement wire JSON. */
    readonly statementJson: string;
    constructor(statementJson: string);
    /** Parse the carried JSON into a plain object view (the engine owns the shape). */
    parsed(): unknown;
    /** The carried wire JSON string is already canonical. */
    toJSON(): string;
    /** Reconstruct from a wire JSON string. */
    static fromJSON(statementJson: string): StealthOutputsStatement;
}

/**
 * Fluent builder for a confidential (stealth) transfer.
 *
 * Supports the full input/output matrix: spend revealed input (withdraw from a vault)
 * and/or one or more confidential UTXOs ({@link spendStealthInput}), emit one or more
 * stealth outputs (+ optional revealed change), and a fee. The balance equation
 * (revealed-in + stealth-in == stealth-out + revealed-out) must hold; the stealth-input
 * value is carried by each input's mask, recovered by the authorizer.
 *
 * @example
 * ```ts
 * const spec = await new StealthTransfer(provider, resourceAddress)
 *   .spendRevealedInput(account, 5n * TARI)
 *   .toStealthOutput(createOutput({ destination, amount: 3n * TARI, resourceAddress }))
 *   .toRevealedOutput(1n * TARI)   // revealed change back to `account`
 *   .payFeeFromRevealed(1n * TARI)
 *   .prepare();
 * ```
 */
export declare class StealthTransfer {
    private readonly provider;
    private readonly crypto;
    private builder;
    private readonly state;
    /** Set by {@link withMaxEpoch}; `null` means {@link prepare} resolves one from the chain tip. */
    private maxEpoch;
    /** Guards against a second {@link prepare} re-emitting instructions into the same builder. */
    private prepared;
    /**
     * When set, revealed change is captured as a bucket on the workspace under this name
     * instead of being auto-deposited back to `revealedInput.source` — see
     * {@link toRevealedOutputAsBucket}.
     */
    private revealedOutputBucketVar;
    /**
     * Extra instructions appended after the native `StealthTransfer` instruction (and its
     * change-bucket handling), in the same transaction — see {@link andThen}. Lets a caller
     * chain e.g. a custom contract call that consumes the bucket saved by
     * {@link toRevealedOutputAsBucket}, all signed together by the authorizer in one
     * transaction instead of needing a separate one.
     */
    private followUpInstructions;
    /**
     * The public key allowed to take the revealed output — see {@link withRevealedReceiver}.
     */
    private revealedReceiver;
    /**
     * @param provider - Read-only chain access (used by {@link prepare} to resolve inputs).
     * @param resourceAddress - The resource being transferred.
     * @param crypto - Injectable crypto seam; defaults to {@link WasmStealthCrypto}. Tests
     *   pass a {@link FakeStealthCrypto} for WASM-free runs.
     */
    constructor(provider: Provider, resourceAddress: ResourceAddress, crypto?: StealthCryptoProvider);
    /**
     * Withdraw `amount` of the transfer's resource from `account`'s revealed vault.
     *
     * All revealed input must come from a single account (the fee/change source). Calling
     * this more than once accumulates the amount but the account must be the same.
     *
     * @throws {InvalidArgumentError} if `amount` is not `> 0`, or a different source
     *   account is supplied on a second call.
     */
    spendRevealedInput(account: ComponentAddress, amount: bigint): this;
    /** Add a stealth output to create (repeatable). */
    toStealthOutput(spec: Output): this;
    /**
     * Add revealed (un-confidential) change, returned to the revealed source account.
     *
     * @throws {InvalidArgumentError} if `amount` is not `> 0`.
     */
    toRevealedOutput(amount: bigint): this;
    /**
     * Like {@link toRevealedOutput}, but instead of auto-depositing the change back into
     * `revealedInput.source`, the `StealthTransfer` instruction's bucket output is left on the
     * workspace under `workspaceVarName` for {@link andThen}'s instructions (or a caller-supplied
     * `withBuilder` continuation) to consume directly — e.g. passing it straight into a custom
     * contract call in the same transaction, rather than requiring a second transaction that
     * withdraws it back out again (which a plain `CallMethod withdraw` on a Stealth-typed vault
     * cannot do standalone — see this class's own `emitInstructions` doc comment: the account
     * template's `withdraw` only produces a valid bucket when paired with the native
     * `StealthTransfer` instruction in the same transaction).
     *
     * A real `toStealthOutput` is still required elsewhere on this builder (`validate()` enforces
     * it): the bundled `ootle-wasm@0.37.0` signer cannot parse a statement with zero stealth
     * outputs at all — confirmed live, `signTransaction`'s own WASM call throws the generic "did
     * not match any variant of untagged enum TransactionInput" error regardless of how
     * `balance_proof` is represented. A small dust self-output (as `OotleAccount.
     * withdrawStealthAndExecute` in tari-wallet-extension does) satisfies this cheaply.
     *
     * @throws {InvalidArgumentError} if `amount` is not `> 0`.
     */
    toRevealedOutputAsBucket(amount: bigint, workspaceVarName: string): this;
    /**
     * Name the public key allowed to take the revealed output (tari-ootle#2645). The engine
     * requires that key's badge in the transaction's auth scope before it creates the revealed
     * bucket, so it must be a key that signs the transaction — normally the account key, which
     * {@link WalletStealthAuthorizer} signs with by default. Required whenever the transfer has a
     * revealed output ({@link toRevealedOutput} / {@link toRevealedOutputAsBucket}).
     *
     * @throws {InvalidArgumentError} if `publicKey` is not 32 bytes.
     */
    withRevealedReceiver(publicKey: Uint8Array): this;
    /**
     * Append `instructions` after the native `StealthTransfer` instruction (and its bucket
     * handling), so they run in the same signed transaction — typically consuming the bucket
     * {@link toRevealedOutputAsBucket} saved to the workspace. Repeatable; each call appends.
     */
    andThen(instructions: Instruction[]): this;
    /**
     * Pay the transaction fee from the revealed source account (max `amount`).
     *
     * @throws {InvalidArgumentError} if no source account is set, or `amount` is not `> 0`.
     */
    payFeeFromRevealed(amount: bigint): this;
    /**
     * Set the transaction's validity window explicitly. Without this, {@link prepare}
     * reads the current epoch from the provider and applies
     * `DEFAULT_TRANSACTION_VALIDITY_EPOCHS`.
     *
     * @throws {InvalidArgumentError} if `maxEpoch` is not a non-negative integer.
     */
    withMaxEpoch(maxEpoch: number): this;
    /** Escape hatch over the inner {@link TransactionBuilder} (e.g. extra instructions). */
    withBuilder(fn: (b: TransactionBuilder) => TransactionBuilder): this;
    /**
     * Spend a confidential UTXO owned by `ownerAddr`, identified by its 32-byte
     * `commitment`.
     *
     * Repeatable: each call adds another stealth input. Inputs are keyed by their
     * **commitment hex alone** and de-duplicated — a second call with the same commitment
     * throws, **regardless of the owner label**. A commitment uniquely identifies a UTXO
     * within the builder's single resource and a UTXO has exactly one owner, so the same
     * commitment under two different owner labels is still the same UTXO; accepting it twice
     * would register the substate id twice and emit the commitment twice in the inputs
     * statement — a self-double-spend the engine rejects. The owner address is recorded
     * alongside the input so the authorizer can pick the one-time spend signer for each.
     *
     * The input's value contributes to the balance equation via its **mask** (recovered by
     * the authorizer when it unblinds the UTXO), so the builder does not need the amount
     * here — only the commitment.
     *
     * @throws {InvalidArgumentError} if `commitment` is not 32 bytes, or the same
     *   commitment is added twice (under any owner).
     */
    spendStealthInput(ownerAddr: string, commitment: Uint8Array): this;
    /**
     * Assemble the unsigned transaction and the (incomplete) transfer statement.
     *
     * 1. validate (≥1 input, ≥1 stealth output);
     * 2. generate the outputs statement (+ aggregated output mask) via the crypto seam;
     * 3. build the inputs statement (concatenated commitments + revealed input
     *    amount) and assemble an incomplete {@link StealthTransferStatement}
     *    (`balanceProof: undefined`);
     * 4. emit instructions: revealed `withdraw` → `saveVar` → the native
     *    `StealthTransfer` instruction (+ deposit the revealed-change bucket);
     * 5. register the revealed source account + every vault it references as tx
     *    inputs (otherwise the engine rejects `withdraw` / `pay_fee` with
     *    `SubstateNotFound`);
     * 6. register each stealth input's UTXO substate id as a tx input so it is
     *    resolved / locked alongside the revealed inputs;
     * 7. resolve substate versions via the provider;
     * 8. return the {@link StealthTransferSpec}.
     *
     * Stealth-input **values** are carried by their masks (recovered later by the
     * authorizer), not as amounts — there is no balance-equation check here when stealth
     * inputs are present, because the builder does not know their values; the balance proof
     * (which the authorizer signs over the recovered masks) is the authoritative check.
     *
     * @throws {InvalidArgumentError} if the builder is invalid (no inputs, no outputs,
     *   no stealth output, unbalanced revealed-only transfer, or revealed change without
     *   a revealed source) or `prepare` has already been called once.
     */
    prepare(): Promise<StealthTransferSpec>;
    /**
     * Build the ordered, de-duplicated list of addresses that must authorize the tx: the
     * revealed source account first (if any), then each distinct stealth-input owner in the
     * order it was first added.
     */
    private collectRequiredSigners;
    /**
     * Validate the builder before assembly: at least one input (revealed and/or stealth) and
     * at least one stealth output, plus — for the revealed-only path — the balance equation
     * `revealedInput.amount == stealthOut + revealedOut`.
     *
     * The fee is withdrawn separately by the fee instruction, not from the transferred
     * amount. When stealth inputs are present, the per-input values are unknown to the builder
     * (carried by masks), so the arithmetic check is **skipped** — the balance proof the
     * authorizer signs is authoritative. We still surface obvious wiring mistakes early.
     */
    private validate;
    /**
     * Emit the instruction sequence into the inner builder:
     * (revealed `withdraw` → `saveVar`)? → native `StealthTransfer` → deposit revealed change?
     *
     * The revealed `withdraw` and the `revealed_input_bucket` are emitted **only** when there
     * is a revealed input amount; a stealth-input-only transfer passes a `null` bucket. The
     * fee instruction (if any) was already added by {@link payFeeFromRevealed}.
     */
    private emitInstructions;
}

/** The narrowed shape of the native `StealthTransfer` instruction variant. */
export declare type StealthTransferInstruction = Extract<Instruction, {
    StealthTransfer: unknown;
}>;

/**
 * Encode the native `StealthTransfer` instruction. See the file header for the on-chain
 * contract and the (probe-verified) statement-encoding rationale.
 *
 * The `revealed_input_bucket` references the saved withdraw bucket by name; the builder
 * declared that name via `saveVar`, so the {@link WorkspaceOffsetId} `{ id, offset: null }`
 * is resolved here against the same name → numeric id mapping the builder uses.
 *
 * @param init - The resource, revealed-input bucket name, and statement.
 * @param resolveBucket - Maps a workspace var name to its {@link WorkspaceOffsetId}. The
 *   builder owns the name → id mapping; pass a resolver so this seam stays builder-agnostic.
 */
export declare function stealthTransferInstruction(init: StealthTransferInstructionInit, resolveBucket: (name: string) => WorkspaceOffsetId): Instruction;

/** Inputs to {@link stealthTransferInstruction}. */
export declare interface StealthTransferInstructionInit {
    /** The resource being transferred. */
    resourceAddress: ResourceAddress;
    /**
     * Workspace var name of the revealed-input bucket (from the `withdraw` + `saveVar`), or
     * `null`/omitted for a stealth-input-only transfer.
     */
    revealedInputBucket: string | null;
    /** The transfer statement (may be incomplete — `balanceProof` undefined — at build time). */
    statement: StealthTransferStatement;
}

/**
 * The output of {@link StealthTransfer.prepare}: an unsigned transaction carrying the
 * on-chain stealth instruction and an **incomplete** statement (`balanceProof:
 * undefined`), plus the metadata the authorizer needs to finish it.
 */
export declare interface StealthTransferSpec {
    /** The unsigned transaction with substate versions resolved. */
    unsignedTx: UnsignedTransactionV1;
    /** The (incomplete) transfer statement; the authorizer fills `balanceProof`. */
    statement: StealthTransferStatement;
    /** The aggregated output blinding mask, needed to sign the balance proof. */
    outputMask: Mask;
    /** The builder state (resource, inputs, amounts) — consumed by the authorizer. */
    state: StealthTransferState;
    /**
     * Addresses that must authorize the transaction. The revealed source account (when there
     * is revealed input) is required first, followed by each distinct stealth-input owner
     * (in first-seen order) — those owners supply the one-time spend-key authorizations.
     */
    requiredSigners: string[];
    /**
     * Ordered list of stealth inputs being spent, each paired with its owner address. Order
     * matches the order `spendStealthInput` was called — required for the input-mask
     * aggregation and inputs-statement build to agree on ordering.
     */
    inputs: Array<{
        input: StealthInput;
        owner: string;
    }>;
}

/** Mutable internal state accumulated by a {@link StealthTransfer} builder. */
export declare interface StealthTransferState {
    resource: ResourceAddress;
    /**
     * The revealed-source account and the total amount withdrawn from it, or `null` for a
     * stealth-input-only spend. Coupling the source and amount in one tagged field encodes the
     * invariant — a revealed input always has a source — in the type system, so consumers can
     * narrow without "unreachable" guards.
     */
    revealedInput: {
        source: ComponentAddress;
        amount: bigint;
    } | null;
    /**
     * Stealth UTXOs to spend, keyed by their **commitment hex alone** (insertion-ordered,
     * duplicates rejected). A commitment uniquely identifies a UTXO within the builder's
     * single resource, and a UTXO has exactly one owner — so keying by commitment (not
     * owner+commitment) prevents the same UTXO being registered twice under different owner
     * labels, which the engine would reject as a self-double-spend. Each value carries the
     * input alongside its owner address (the one-time spend signer). The `Map` preserves
     * insertion order so the masks aggregate and the inputs statement is built in the
     * **same** order — required for the balance proof to verify.
     */
    inputsToSpend: Map<string, {
        input: StealthInput;
        owner: string;
    }>;
    outputs: Output[];
    revealedOutputAmount: bigint;
}

/**
 * The top-level stealth-transfer envelope assembled **in TS**.
 *
 * Combines the WASM-produced inputs/outputs statement JSONs with the balance-proof
 * `(public_nonce, signature)`. `balanceProof` is `undefined` until the authorizer
 * fills it in.
 *
 * Two distinct serialisations, intentionally separate:
 *
 * 1. **{@link toJSON} / {@link fromJSON}** — a purely *structural*, symmetric,
 *    lossless round-trip used by tests and any TS-only persistence. It does NOT
 *    re-parse WASM statement strings into JS numbers; the outputs side is carried as
 *    its raw wire string.
 * 2. **{@link toCompactJson}** — the *signed wire form*. It embeds the
 *    WASM-produced statement strings **byte-exact** by string concatenation of raw
 *    canonical fragments — it **never** `JSON.parse`s a WASM string (raw u64 µTari
 *    amounts routinely exceed 2^53, so parse→number→re-stringify silently corrupts
 *    them and breaks the signature). This is the form fed to
 *    `validateStealthTransfer` and any hashing/signing path.
 *
 * The **byte-exactness of the WASM fragments** in {@link toCompactJson} is
 * non-negotiable: the engine validates against the exact bytes signed.
 */
export declare class StealthTransferStatement {
    readonly inputsStatement: StealthInputsStatement;
    readonly outputsStatement: StealthOutputsStatement;
    balanceProof?: BalanceProofSignature;
    constructor(inputsStatement: StealthInputsStatement, outputsStatement: StealthOutputsStatement, balanceProof?: BalanceProofSignature);
    /**
     * Structural view of the envelope (debug / lossless round-trip — NOT the signed
     * wire form; see {@link toCompactJson}). The inputs side is the inputs statement's
     * structural `toJSON()`; the outputs side is its **raw wire string**, carried
     * verbatim (never parsed). `balance_proof` is omitted when undefined.
     */
    toJSON(): StealthTransferStatementJson;
    /**
     * The **signed wire form**: a single canonical compact JSON string in which the
     * WASM-produced statement fragments are embedded byte-exact.
     *
     * Built by concatenating raw canonical fragments — it never `JSON.parse`s a WASM
     * statement string, so raw u64 µTari amounts (which can exceed 2^53) survive
     * uncorrupted. The inputs fragment prefers the cached WASM `statementJson` (the
     * canonical signed bytes); it falls back to `JSON.stringify` of the structural
     * inputs view only when no WASM string is present (the revealed-only / test case).
     * The outputs fragment is always the raw WASM `statementJson` string. The
     * balance-proof object is small, all-hex (no large integers), so it routes through
     * `JSON.stringify` safely.
     *
     * @throws {InvalidArgumentError} if either statement fragment is not a JSON object.
     */
    toCompactJson(): string;
    /** Reconstruct from the structural {@link toJSON} shape. Symmetric and lossless. */
    static fromJSON(json: StealthTransferStatementJson): StealthTransferStatement;
}

/**
 * Structural wire shape of a {@link StealthTransferStatement} envelope.
 *
 * This is the **debug / round-trip** shape produced by `toJSON()` and consumed by
 * `fromJSON()` — it is symmetric and lossless for a TS-only envelope. It is **NOT**
 * the signed wire form: see {@link StealthTransferStatement.toCompactJson}.
 *
 * - `inputs` is the structural inputs-statement view (`{ inputs, revealed_amount }`).
 * - `outputs` is the **raw `StealthOutputsStatement` wire string** (carried verbatim),
 *   never a parsed object — parsing-then-restringifying WASM u64 amounts is lossy.
 */
declare interface StealthTransferStatementJson {
    inputs: {
        inputs: StealthInputJson[];
        revealed_amount: string;
    };
    outputs: string;
    balance_proof?: BalanceProofSignatureJson;
}

/**
 * Compose a stealth UTXO substate id from a resource address and a 32-byte commitment.
 *
 * The id format is `utxo_{resourceHex}_{commitmentHex}`, where `resourceHex` is the
 * resource address with its `resource_` prefix stripped (a bare hex string is accepted
 * verbatim). This is the inverse of {@link commitmentOf} and matches the id the
 * `IndexerProvider.getStealthUtxo` fetch composes, so the spend builder can register a
 * stealth input as a tx input **without** reaching into the concrete indexer client.
 *
 * @param resourceAddress - The resource address (`resource_<hex>`) or a bare hex string.
 * @param commitment - The output's 32-byte Pedersen commitment.
 * @returns The `utxo_{resourceHex}_{commitmentHex}` substate id.
 */
export declare function stealthUtxoSubstateId(resourceAddress: string, commitment: Uint8Array): string;

/** CBOR-encode a `String` as a CBOR text string. */
export declare function stringLiteral(value: string): InstructionArg;

/**
 * Submits an encoded transaction envelope and returns the transaction ID.
 */
export declare function submitTransaction(provider: Provider, envelope: TransactionEnvelope): Promise<string>;

export { SubstateId }

export { SubstateRequirement }

/**
 * Native TARI (XTR) token resource address (object key `[1u8; 32]`). Used for
 * all native-token transfers and stealth confidential outputs.
 */
export declare const TARI_RESOURCE_ADDRESS = "resource_0101010101010101010101010101010101010101010101010101010101010101";

/** A function that can be called on a published template. */
export declare interface TariFunctionDefinition {
    templateAddress: PublishedTemplateAddress;
    functionName: string;
    args?: NamedArg[];
}

/** A method that can be called on a component. */
export declare interface TariMethodDefinition {
    methodName: string;
    args?: NamedArg[];
    /** Call by component address. Mutually exclusive with `fromWorkspace`. */
    componentAddress?: ComponentAddress;
    /** Call the component stored under this workspace key. Mutually exclusive with `componentAddress`. */
    fromWorkspace?: string;
}

/**
 * CBOR-encode a `PublishedTemplateAddress` as `Tag(137, bytes(32))`. Accepts
 * either the `template_<hex>` form or the bare 64-hex-char tail.
 *
 * @throws {InvalidArgumentError} if the address body is not 32 bytes (64 hex chars).
 */
export declare function templateAddressLiteral(address: PublishedTemplateAddress): InstructionArg;

/**
 * Implemented by types that can produce a component address string.
 * Mirrors the `ToAccountAddress` trait from ootle-rs.
 */
export declare interface ToAccountAddress {
    toAccountAddress(): string;
}

export declare function toHexStr(uint8: Uint8Array): string;

export { Transaction }

/**
 * The result of authorizing a transaction: a set of signatures from one signer.
 * Mirrors `TransactionAuthorization` from the Rust ootle-rs crate.
 */
export declare interface TransactionAuthorization {
    signerAddress: string;
    signatures: TransactionSignature[];
}

/**
 * Fluent builder for constructing UnsignedTransactionV1 objects.
 *
 * Only `buildUnsignedTransaction()` is exposed — signing is handled separately
 * via the `Signer` interface and `signTransaction` flow function.
 */
export declare class TransactionBuilder {
    private unsignedTransaction;
    private workspaceIds;
    private feeWorkspaceIds;
    /**
     * `maxEpoch` is required: every transaction now carries a bounded validity window
     * (`UnsignedTransactionV1.max_epoch`), so the last epoch in which it may be sequenced
     * is decided up front rather than left open. The network rejects a window longer than
     * {@link MAX_TRANSACTION_VALIDITY_EPOCHS} epochs past the current one with
     * `AbortReason::ValidityWindowTooLong`, so derive it from the chain tip — e.g.
     * `(await provider.getCurrentEpoch()) + 10`.
     *
     * @throws {InvalidArgumentError} if `maxEpoch` is not a non-negative integer.
     */
    constructor(network: Network | number, maxEpoch: number);
    static new(network: Network | number, maxEpoch: number): TransactionBuilder;
    callFunction<T extends TariFunctionDefinition>(func: T, args: Exclude<T["args"], undefined>): this;
    /**
     * @throws {InvalidArgumentError} if `method` provides neither `componentAddress`
     *   nor `fromWorkspace`, or if `fromWorkspace` references an undefined variable.
     */
    callMethod<T extends TariMethodDefinition>(method: T, args: Exclude<T["args"], undefined>): this;
    createAccount(ownerPublicKey: string, workspaceBucket?: string): this;
    createProof(account: ComponentAddress, resourceAddress: ResourceAddress): this;
    claimBurn(claim: MinotariBurnClaimProof, output_data: ClaimBurnOutputData): this;
    allocateAddress(allocatableType: AllocatableAddressType, workspaceIdName: string): this;
    /**
     * Saves the last instruction output to a named workspace variable.
     * The variable can be referenced by subsequent instructions using `{ Workspace: "name" }`.
     */
    saveVar(name: string): this;
    /**
     * Adds a fee instruction that calls `pay_fee` on the given component.
     * The component must call `vault.pay_fee` and reveal enough confidential XTR.
     */
    feeTransactionPayFromComponent(componentAddress: ComponentAddress, maxFee: bigint): this;
    /**
     * NOT IMPLEMENTED — always throws. A confidential `pay_fee` needs a
     * `ConfidentialWithdrawProof` `Literal` that requires `tari_bor` struct encoding
     * the TS SDK does not yet provide. Use {@link feeTransactionPayFromComponent} for
     * revealed-fee payment.
     *
     * @throws {InvalidArgumentError} always.
     */
    feeTransactionPayFromComponentConfidential(_componentAddress: ComponentAddress, _proof: ConfidentialWithdrawProof): this;
    dropAllProofsInWorkspace(): this;
    /**
     * Publishes a compiled WASM template. The binary is stored as a transaction
     * blob and referenced by index from the `PublishTemplate` instruction.
     *
     * @param binaryBase64 the template WASM, standard-base64 encoded
     * @param metadataHash optional multihash of off-chain CBOR metadata
     */
    publishTemplate(binaryBase64: string, metadataHash?: string | null): this;
    addInstruction(instruction: Instruction): this;
    addFeeInstruction(instruction: Instruction): this;
    withInstructions(instructions: Instruction[]): this;
    withFeeInstructions(instructions: Instruction[]): this;
    /**
     * Account for slots claimed by instructions the builder did not allocate itself, so a
     * later `saveVar` cannot re-issue one. Rust does this inline in `add_instruction`.
     */
    private observeAllocations;
    /**
     * Build the fee instructions with a nested builder, mirroring the Rust builder's separate
     * fee-instruction builder. The nested builder gets its own workspace scope — correct,
     * because the engine clears the workspace between the fee and main instruction runs.
     *
     * Note this REPLACES any fee instructions already set, as it always has.
     */
    withFeeInstructionsBuilder(builder: (b: TransactionBuilder) => TransactionBuilder): this;
    /**
     * Declare a transaction input. Since tari-ootle#2640 every input declares read or write
     * intent; a plain {@link SubstateRequirement} (no `is_write`) is declared a **write**, the
     * engine's own default — over-declaring only locks more, under-declaring aborts execution.
     */
    addInput(input: SubstateRequirement | InputDeclaration): this;
    withInputs(inputs: (SubstateRequirement | InputDeclaration)[]): this;
    /** @throws {InvalidArgumentError} if `minEpoch` is not a non-negative integer. */
    withMinEpoch(minEpoch: number): this;
    /**
     * Overrides the validity window set at construction. See the constructor for the
     * network's cap on how far ahead of the current epoch this may sit.
     *
     * @throws {InvalidArgumentError} if `maxEpoch` is not a non-negative integer.
     */
    withMaxEpoch(maxEpoch: number): this;
    /**
     * Stamps the transaction nonce, which distinguishes otherwise-identical transactions.
     *
     * The transaction id excludes the seal signature's witness data, so two identical
     * bodies sealed by the same key are the *same* transaction — submitting both executes
     * once. Give each intent a distinct nonce when repeated submissions must each execute.
     * Defaults to `0`.
     *
     * @throws {InvalidArgumentError} if `nonce` is negative or overflows u64.
     */
    withNonce(nonce: number | bigint): this;
    /**
     * Adopt an existing transaction and keep building on it.
     *
     * The adopted transaction is **copied**, not aliased: subsequent builder calls must not
     * reach back into the caller's object. The manual co-signing flow ships
     * `JSON.stringify(unsigned)` across a boundary, so mutating a transaction the caller has
     * already serialized or signed makes the two sides disagree — surfacing only at submit
     * time as the opaque engine error `"Transaction has one or more invalid signature(s)"`.
     * This mirrors the copy {@link buildUnsignedTransaction} makes on the way out.
     */
    withUnsignedTransaction(unsignedTransaction: UnsignedTransactionV1): this;
    /**
     * Resolves a workspace variable name (supporting dot-notation offsets, e.g. `"bucket.0"`)
     * to its `WorkspaceOffsetId`. The variable must have been declared by a prior `saveVar`
     * (or other allocating call). Use this when constructing an `Instruction` that takes a
     * `WorkspaceOffsetId` directly (e.g. the native `StealthTransfer` variant's
     * `revealed_input_bucket`), where the builder's automatic `{ Workspace: "name" }` arg
     * resolution does not apply.
     *
     * @throws {InvalidArgumentError} if no workspace variable with that name has been defined.
     */
    resolveWorkspaceOffsetId(name: string): WorkspaceOffsetId;
    buildUnsignedTransaction(): UnsignedTransactionV1;
    private addNamedId;
    private requireNamedId;
    private getOffsetIdFromWorkspaceName;
    private resolveArgs;
}

export { TransactionEnvelope }

/**
 * The classified result of a finalized transaction.
 *
 * - `"Commit"` — all instructions committed successfully.
 * - `"FeeIntentCommit"` — fee instructions committed but execution was aborted
 *   (the network accepted the fee intent but rejected the rest).
 * - `"Reject"` — the entire transaction was rejected.
 */
export declare interface TransactionOutcome {
    outcome: FinalizeOutcome | "Reject";
    reason?: string;
}

/**
 * Raised when consensus rejects a transaction.
 *
 * `txId` is the rejected transaction's identifier; `reason` is the human-readable
 * reason (the indexer's `abort_details` string or a `JSON.stringify` of the abort
 * variant when no string was supplied). `rejectReason` is the structured engine
 * reject reason if available — currently optional because the indexer's
 * `Decision.Abort` carries the lighter `AbortReason` shape, not the full
 * `RejectReason`. Callers should branch on `reason` (string) for most cases.
 */
export declare class TransactionRejectedError extends OotleError {
    readonly txId: string;
    readonly reason: string;
    readonly rejectReason?: RejectReason;
    constructor(message: string, options: ErrorOptions & {
        txId: string;
        reason: string;
        rejectReason?: RejectReason;
    });
}

export { TransactionSignature }

/** Raised when polling / SSE both timed out before the transaction finalized. */
export declare class TransactionTimeoutError extends OotleError {
    readonly txId: string;
    constructor(message: string, options: ErrorOptions & {
        txId: string;
    });
}

export { TransactionV1 }

export { UnsealedTransactionV1 }

export { UnsignedTransactionV1 }

/**
 * `UnsignedTransactionV1` with the `blobs` list: standard-base64 payloads
 * referenced from instructions by index (see {@link TransactionBuilder.publishTemplate}).
 *
 * @deprecated `blobs` is now a field of `UnsignedTransactionV1` itself (ootle-ts-bindings
 * ≥ 1.47), so this intersection adds nothing. Kept as an alias for one release; use
 * `UnsignedTransactionV1` directly.
 */
export declare type UnsignedTransactionWithBlobs = UnsignedTransactionV1;

/**
 * CBOR-encode a `UtxoAddress` as `Tag(141, [ResourceAddress, UtxoId])`, where the
 * `UtxoId` is the 32-byte commitment byte string.
 *
 * @throws {InvalidArgumentError} if the resource address or id is not 32 bytes.
 */
export declare function utxoAddressLiteral(address: UtxoAddress): InstructionArg;

/**
 * CBOR-encode a `ValidatorFeePoolAddress` as `Tag(138, bytes(32))`. Accepts
 * either the `vnfp_<hex>` form or the bare 64-hex-char tail.
 *
 * @throws {InvalidArgumentError} if the address body is not 32 bytes (64 hex chars).
 */
export declare function validatorFeePoolAddressLiteral(address: ValidatorFeePoolAddress): InstructionArg;

/**
 * CBOR-encode a `VaultId` as `Tag(132, bytes(32))`. Accepts either the
 * `vault_<hex>` form or the bare 64-hex-char tail.
 *
 * @throws {InvalidArgumentError} if the address body is not 32 bytes (64 hex chars).
 */
export declare function vaultIdLiteral(address: VaultId): InstructionArg;

/** Base class for errors raised by {@link OotleWallet} operations. */
export declare class WalletError extends OotleError {
}

/**
 * Authorizes a {@link StealthTransferSpec} produced by {@link StealthTransfer}: unblinds any
 * stealth inputs, signs the balance proof, hydrates + patches the statement, then returns an
 * {@link AuthorizedTransfer} that produces one-time spend-key authorizations and seals the
 * envelope. Handles both the revealed-only path and the full stealth-input spend path.
 */
export declare class WalletStealthAuthorizer {
    private readonly wallet;
    private readonly spec;
    private readonly crypto;
    private readonly mustSignWithAccountKey;
    private readonly viewSecret?;
    private constructor();
    /**
     * Build an authorizer from a builder spec.
     *
     * @param wallet - The multi-signer wallet (supplies the account-key + one-time signatures).
     * @param spec - The spec from {@link StealthTransfer.prepare}.
     * @param options - Optional `viewSecret`, account-signature toggle, crypto seam.
     */
    static fromSpec(wallet: OotleWallet, spec: StealthTransferSpec, options?: WalletStealthAuthorizerOptions): WalletStealthAuthorizer;
    /**
     * Hydrate + sign the transfer:
     * 1. resolve each stealth input — fetch its UTXO, unblind it to recover the mask, and
     *    remember the sender public nonce (revealed-only → no inputs, no fetch);
     * 2. aggregate the input masks (`Mask.zero()` when there are no stealth inputs);
     * 3. sign the balance proof over the (already-canonical) inputs/outputs statement JSONs;
     * 4. build the complete (hydrated) statement and pre-flight `validateTransfer`;
     * 5. patch the unsigned tx's sole stealth instruction with the hydrated statement.
     *
     * Returns an {@link AuthorizedTransfer} that owns the hydrated state and can produce
     * one-time spend-key authorizations or seal the envelope. The authorizer is not mutated.
     *
     * @param provider - Read-only chain access (fetches the input UTXOs).
     */
    prepare(provider: Provider): Promise<AuthorizedTransfer>;
    /**
     * Resolve the view secret used to unblind stealth inputs: prefer the explicit one passed
     * to {@link fromSpec}; else fall back to the wallet's default signer `getViewSecret?.()`.
     *
     * @throws {WalletError} a clear, actionable error when neither is available **and**
     *   there are stealth inputs to unblind (the revealed-only path never needs it).
     */
    private resolveViewSecret;
    /** The wallet's default signer address, or `""` if none is set (so view-secret resolution fails clearly). */
    private safeDefaultAddress;
    /**
     * Fetch + unblind each stealth input, in `spec.inputs` order.
     *
     * For each input: `getStealthUtxo` → `parseSubstateUtxo` (commitment + body) →
     * `decryptInputData(..., { senderPublicNonce, viewSecret, skipMemo: true })` to recover
     * the mask. The sender public nonce is read from the **fetched UTXO body**, not the spec
     * (the spec only carries the commitment), and kept for one-time signing.
     *
     * `skipMemo: true` — spending only needs the mask + value, not the memo (vs the
     * receive-side `decryptOwnedUtxo`, which decrypts the memo).
     */
    private resolveStealthInputs;
}

/** Options for {@link WalletStealthAuthorizer.fromSpec}. */
export declare interface WalletStealthAuthorizerOptions {
    /**
     * The owner/recipient 32-byte view secret, needed to unblind stealth inputs. **Optional**:
     * the revealed-only path never uses it; for stealth-input transfers it is taken here first,
     * else falls back to the wallet's default signer `getViewSecret?.()` (only `SecretKeyWallet`
     * supplies one). If neither is available and there are stealth inputs, `prepare` throws.
     */
    viewSecret?: Uint8Array;
    /**
     * Whether to append the account-key Schnorr signature when sealing. Defaults to `true`.
     * Set `false` to omit it (e.g. the account already authorized out-of-band).
     */
    mustSignWithAccountKey?: boolean;
    /**
     * Injectable crypto seam; defaults to {@link WasmStealthCrypto}. Tests pass a
     * {@link FakeStealthCrypto}.
     */
    crypto?: StealthCryptoProvider;
}

/**
 * The real `StealthCryptoProvider`, backed by `@tari-project/ootle-wasm@0.38.0`.
 *
 * Marshals between the step-02 domain types (`Mask`, `Output`, statements) and the raw
 * WASM ABI (snake_case result fields, positional args, raw `Uint8Array`s/`bigint`s).
 * Async signatures wrap synchronous WASM calls — see {@link StealthCryptoProvider}.
 */
export declare class WasmStealthCrypto implements StealthCryptoProvider {
    /**
     * The network byte fed to the WASM output-witness and DH calls. Defaults to
     * {@link Network.LocalNet}; pass the target network for non-local transfers.
     */
    private readonly network;
    constructor(network?: Network);
    generateOutputsStatement(specs: Output[], revealedOutputAmount: bigint, revealedReceiver?: Uint8Array): Promise<{
        statement: StealthOutputsStatement;
        outputMask: Mask;
    }>;
    /** Build a single output witness JSON via WASM, mapping an {@link Output} spec. */
    private outputWitness;
    buildInputsStatement(inputs: StealthInput[], revealedAmount: bigint): Promise<StealthInputsStatement>;
    generateBalanceProofSignature(inputMask: Mask, outputMask: Mask, inputsStatementJson: string, outputsStatementJson: string): Promise<BalanceProofSignature>;
    validateBalanceProofSignature(proof: BalanceProofSignature, inputsStatementJson: string, outputsStatementJson: string): Promise<boolean>;
    deriveAeadKey(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array>;
    unblindOutput(commitment: Uint8Array, encryptedData: Uint8Array, aeadKey: Uint8Array, skipMemo: boolean): Promise<DecryptedData>;
    aggregateInputMasks(masks: Mask[]): Promise<Mask>;
    stealthDhSecret(networkByte: number, ownerSecret: Uint8Array, publicNonce: Uint8Array): Promise<Uint8Array>;
    validateTransfer(statement: StealthTransferStatement): Promise<void>;
}

export declare interface WatchOptions {
    /** How often to poll for the transaction result, in milliseconds. Defaults to 500ms. */
    pollIntervalMs?: number;
    /** Maximum time to wait before throwing a timeout error, in milliseconds. Defaults to 60000ms. */
    timeoutMs?: number;
}

/**
 * Polls the provider until a transaction reaches a finalized state, then returns the result.
 *
 * Throws for `Reject` outcomes. `FeeIntentCommit` (fees paid, execution aborted) also
 * throws with a distinct message so callers can distinguish it from a full rejection.
 * Use `classifyOutcome` on the raw result for non-throwing outcome inspection.
 *
 * @throws {TransactionRejectedError} when consensus rejects the transaction, or commits
 *   only the fee intent (execution aborted). The error's `.txId` and `.reason` carry the
 *   structured fields; the message remains the human-readable summary.
 * @throws {TransactionTimeoutError} when the transaction did not finalize within
 *   `timeoutMs`. The error's `.txId` identifies the polled transaction.
 */
export declare function watchTransaction(provider: Provider, txId: string, opts?: WatchOptions): Promise<IndexerGetTransactionResultResponse>;

/** Claim resource held by the XTR faucet (object key `[1, 2, 3, 0, …, 0, 2]`). */
export declare const XTR_FAUCET_CLAIM_RESOURCE_ADDRESS = "resource_0102030000000000000000000000000000000000000000000000000000000002";

/**
 * On-chain XTR faucet component address (object key `[1, 2, 3, 0, …, 0]`).
 * LocalNet scripts call this via `FaucetInvokeBuilder` to claim revealed TARI funds.
 */
export declare const XTR_FAUCET_COMPONENT_ADDRESS = "component_0102030000000000000000000000000000000000000000000000000000000000";

/** Vault held by the XTR faucet (object key `[1, 2, 3, 0, …, 0, 1]`). */
export declare const XTR_FAUCET_VAULT_ADDRESS = "vault_0102030000000000000000000000000000000000000000000000000000000001";

export { }
