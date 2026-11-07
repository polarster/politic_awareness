import { feedbackUrl, type FeedbackKind } from "../config";

export function FeedbackLink({ kind, target, label }: { kind: FeedbackKind; target?: string; label?: string }) {
  const url = feedbackUrl(kind, target);
  if (!url) return null;
  return (
    <a className="feedback" href={url} target="_blank" rel="noreferrer">
      {label ?? "回報問題"}
    </a>
  );
}
