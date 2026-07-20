import type { ExitAdvisory } from "../services/exitAdvisory";
import { dismissExitAdvisory, formatExitAdvisoryUr } from "../services/exitAdvisory";

interface Props {
  advisory: ExitAdvisory | null;
  onDismiss?: () => void;
}

export function ExitAdvisoryBanner({ advisory, onDismiss }: Props) {
  if (!advisory) return null;
  return (
    <div className="exit-advisory" role="alert">
      <div className="exit-advisory-head">
        <strong>EXIT ALERT</strong>
        <button
          type="button"
          className="exit-advisory-dismiss"
          onClick={() => {
            dismissExitAdvisory(advisory.moduleKey);
            onDismiss?.();
          }}
        >
          Dismiss
        </button>
      </div>
      <p>{formatExitAdvisoryUr(advisory)}</p>
      <p className="exit-advisory-reason">Reason: {advisory.reason}</p>
    </div>
  );
}
