interface Props {
  onStartHint: () => void;
}

export function BackgroundAlertBanner({ onStartHint }: Props) {
  return (
    <section className="panel bg-alert-banner">
      <h3>Background alerts (tab band bhi)</h3>
      <p>
        Browser band / dusri tab pe ho — phir bhi entry pe toast + beeps chahiye hon to yeh
        command <strong>alag terminal</strong> mein chalu rakho:
      </p>
      <pre className="cmd-box">npm run alerts</pre>
      <p className="muted">
        Yeh bot live price check karta hai. Sirf jab price locked entry ke paas ho aur
        confidence + win chance high ho — tab alert. Refresh ki zaroorat nahi.
      </p>
      <button type="button" className="new-plan-btn" onClick={onStartHint}>
        Copy command
      </button>
    </section>
  );
}
