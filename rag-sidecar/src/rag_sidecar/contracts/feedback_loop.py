from pydantic import BaseModel, ConfigDict


class _Placeholder(BaseModel):
    model_config = ConfigDict(extra="allow")


class RetrievalLogCandidate(_Placeholder):
    pass


class RetrievalLogEntry(_Placeholder):
    pass


class RefusalFeedbackRequest(_Placeholder):
    pass


class EmbedFeedbackRequest(_Placeholder):
    pass


class SourceSignalRequest(_Placeholder):
    pass


class ReviewItem(_Placeholder):
    pass


class ReviewItemListResponse(_Placeholder):
    pass


class ExpertLabel(_Placeholder):
    pass


class ExpertEvidenceSpan(_Placeholder):
    pass


class DictionaryTerm(_Placeholder):
    pass


class DictionaryCandidate(_Placeholder):
    pass


class TrainingPair(_Placeholder):
    pass


class TrainingPositive(_Placeholder):
    pass


class TrainingNegative(_Placeholder):
    pass


class FeedbackMiningConfig(_Placeholder):
    pass


class MiningRunResult(_Placeholder):
    pass


class FeedbackLoopStats(_Placeholder):
    pass


class WeeklyReport(_Placeholder):
    pass


class FailureReport(_Placeholder):
    pass


class FailureEntry(_Placeholder):
    pass


class GatePopulationConfig(_Placeholder):
    pass


class ShipCheckResult(_Placeholder):
    pass
