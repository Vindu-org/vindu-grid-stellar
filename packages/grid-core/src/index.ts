/**
 * @vindu/grid-core: types, transfer states, routing rules and the partner
 * adapter interface for two-leg transfers settled on Stellar.
 *
 * Pure TypeScript. No network, no environment reads, no partner code.
 *
 * The exports are listed one by one: constants used only inside the package
 * (the error snippet cap, the routing chain id) are not part of the public
 * surface.
 */
export {
  type Asset,
  type AssetCode,
  assetKey,
  fiat,
  isStellarAccountId,
  isValidAssetCode,
  sameAsset,
  stellarAsset,
} from './assets';
export {
  type AccountModel,
  accountModelFor,
  type CapabilityRegistry,
  type Corridor,
  type PartnerCapabilities,
  supportsCorridor,
} from './capabilities';
export {
  AssetMismatchError,
  type CoreErrorCode,
  GridError,
  type GridErrorCode,
  InvalidConfigError,
  InvalidInputError,
  InvalidMoneyError,
  InvalidTransitionError,
  PartnerHttpError,
  type PartnerHttpErrorInit,
  PayoutAuthorizationError,
  type PayoutAuthorizationFailure,
  PayoutIncompleteError,
  type PayoutIncompleteInit,
  type PayoutIncompleteStage,
  type PendingPayout,
  QuoteExpiredError,
  type QuoteExpiredStage,
  type RouteExclusion,
  RouteImmutableError,
  RouteNotFoundError,
  type SignerRefusalKind,
  SignerRefusedError,
  SigningNotAllowedError,
  ToleranceExceededError,
  WebhookRejectedError,
} from './errors';
export {
  add,
  assertBps,
  assertSameAsset,
  compare,
  equals,
  exceedsBps,
  formatAmount,
  fromMinorUnits,
  fromUnits,
  isPositive,
  isValidAmount,
  isZero,
  MAX_DECIMALS,
  type Money,
  money,
  parseAmount,
  relativeDifferenceBps,
  sub,
  toMinorUnits,
  toUnits,
} from './money';
export {
  type LogFields,
  type Logger,
  noopLogger,
  type OnPartnerCall,
  type PartnerCall,
  reportPartnerCall,
} from './observability';
export type {
  AccountRef,
  Chain,
  CreateFundingInput,
  ExecutePayoutInput,
  Fee,
  FundingInstructions,
  FundingQuoteInput,
  FundingRail,
  LegEvent,
  LegKind,
  LegQuote,
  LegRef,
  LegStatus,
  LegStatusValue,
  OffRampRail,
  PartnerAdapter,
  PartnerId,
  PayoutAuthorization,
  PayoutQuoteInput,
  PreparePayoutInput,
  WebhookHeaders,
} from './ports';
export {
  assertRouteImmutable,
  type CandidateExclusion,
  type ExclusionReason,
  isRouteLocked,
  type Route,
  type RouteCandidate,
  type RouteDecision,
  type RouteOptions,
  type RoutePrice,
  type RouteReason,
  sameRoute,
  selectRoute,
} from './routing';
export {
  type ConfirmedSubmitOutcome,
  DEFAULT_EXPIRY_MARGIN_MS,
  type PayoutSubmission,
  retryPayoutExecute,
  runSignedPayout,
  type RunSignedPayoutInput,
  type SignedPayoutContext,
  type SignedPayoutResult,
  type SignedPayoutSigning,
  signingContextFor,
  type StellarXdrAuthorization,
} from './signed-payout';
export {
  assertMaxTimeWithinQuote,
  assertSigningAllowed,
  type Custody,
  type ExpectedPayment,
  type Signer,
  type SigningContext,
} from './signer';
export {
  canSignReplacement,
  REPLACEMENT_ALLOWED_STATUSES,
  type StellarSubmitter,
  type SubmitOutcome,
  type SubmitOutcomeDetail,
  type SubmitOutcomeStatus,
} from './submission';
export { checkPayoutTolerance, type ToleranceResult } from './tolerance';
export {
  allowedTransitions,
  canTransition,
  getTransition,
  isTerminal,
  isTransferState,
  TERMINAL_STATES,
  TRANSFER_STATES,
  type TransferState,
  transition,
  type TransitionReason,
  type TransitionRule,
  transitionRules,
  TRANSITIONS,
} from './transfer-states';
