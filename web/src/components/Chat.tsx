import { useCallback, useEffect, useRef, useState } from "react";
import { data, questionById } from "../data";
import { ApiError, postChat, type ApiMessage, type ContentBlock } from "../lib/api";
import { positionSummary, stateSummary } from "../lib/chatContext";
import { ANSWER_OPTIONS, answerLabel } from "../lib/labels";
import type { Answers, BudgetSteps } from "../lib/types";
import { UsageMeter, useUsagePolling } from "./UsageMeter";

interface Props {
  answers: Answers;
  budget: BudgetSteps | null;
  cityName: string | null;
  onAnswerChange: (id: string, v: number, reason: string) => void;
  onImportanceChange: (id: string, imp: boolean, reason: string) => void;
  onSupplementaryAnswer: (id: string, v: number | null) => void;
}

type ToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface Decision {
  label: string;
  result: string;
  isError?: boolean;
}

const USER_TEXT_MARKER = "【使用者訊息】\n";

function isToolUse(b: ContentBlock): b is ToolUse {
  return b.type === "tool_use";
}

function toolUses(m: ApiMessage | undefined): ToolUse[] {
  if (!m || m.role !== "assistant" || typeof m.content === "string") return [];
  return m.content.filter(isToolUse);
}

/** 檢查 Claude 的工具輸入；不合法時回傳錯誤訊息。 */
function validate(t: ToolUse, answers: Answers): string | null {
  const qid = t.input.question_id;
  if (typeof qid !== "string" || !questionById.has(qid)) return `未知的題目 id：${String(qid)}`;
  const isSupp = data.supplementary.some((q) => q.id === qid);
  if (t.name === "ask_supplementary") {
    if (!isSupp) return `${qid} 不在補充題庫中`;
    return null;
  }
  if (t.name === "propose_answer_change") {
    const v = t.input.new_value;
    if (typeof v !== "number" || ![-2, -1, 0, 1, 2].includes(v)) return "new_value 必須是 -2 到 2 的整數";
    if (!(qid in answers)) return `使用者尚未回答 ${qid}，請改用 ask_supplementary 或先詢問`;
    return null;
  }
  if (t.name === "propose_importance_change") {
    if (typeof t.input.important !== "boolean") return "important 必須是 true 或 false";
    if (!(qid in answers)) return `使用者尚未回答 ${qid}`;
    return null;
  }
  return `未知的工具 ${t.name}`;
}

export function Chat(props: Props) {
  const { answers, budget, cityName } = props;
  const [consent, setConsent] = useState(false);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const [usage, setUsage] = useState<number | null>(null);
  useUsagePolling(useCallback((p: number) => setUsage(p), []));
  const usageFull = usage !== null && usage >= 100;

  const last = messages[messages.length - 1];
  const pending = toolUses(last).filter((t) => !decisions[t.id]);
  const waitingForTools = pending.length > 0;
  const started = messages.length > 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length, loading]);

  async function send(next: ApiMessage[]) {
    setMessages(next);
    setLoading(true);
    setError(null);
    try {
      const res = await postChat(next);
      setMessages([...next, { role: "assistant", content: res.content }]);
      setUsage(res.usage_percent);
    } catch (e) {
      const lastSent = next[next.length - 1];
      if (e instanceof ApiError && e.status === 409 && typeof lastSent.content === "string") {
        // Claude 拒絕回應：撤回這則訊息，讓使用者換個說法
        setMessages(next.slice(0, -1));
        const idx = lastSent.content.indexOf(USER_TEXT_MARKER);
        setInput(idx >= 0 ? lastSent.content.slice(idx + USER_TEXT_MARKER.length) : lastSent.content);
      }
      setError(e instanceof Error ? e.message : "連線失敗");
    } finally {
      setLoading(false);
    }
  }

  // 不合法的工具呼叫直接回報錯誤
  useEffect(() => {
    const bad: Record<string, Decision> = {};
    for (const t of pending) {
      const err = validate(t, answers);
      if (err) bad[t.id] = { label: "（系統）無法處理這項建議", result: err, isError: true };
    }
    if (Object.keys(bad).length) setDecisions((d) => ({ ...d, ...bad }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last]);

  // 最後一則 assistant 訊息的工具都處理完後，把所有結果放在同一則訊息送回
  useEffect(() => {
    const uses = toolUses(last);
    if (!uses.length || loading) return;
    if (!uses.every((t) => decisions[t.id])) return;
    const results: ContentBlock[] = uses.map((t) => ({
      type: "tool_result",
      tool_use_id: t.id,
      content: decisions[t.id].result,
      ...(decisions[t.id].isError ? { is_error: true } : {}),
    }));
    void send([...messages, { role: "user", content: results }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisions, last]);

  function decide(id: string, d: Decision) {
    setDecisions((prev) => ({ ...prev, [id]: d }));
  }

  function afterSummary(next: Answers) {
    return `\n更新後的維度位置：\n${positionSummary(next, budget)}`;
  }

  function sendUserText(text: string, discussionId?: string) {
    const t = text.trim();
    if (!t) return;
    let content = t;
    if (!started) {
      content = stateSummary(answers, budget, cityName)
        + (discussionId ? `\n\n【討論主題】${discussionId}` : "")
        + `\n\n${USER_TEXT_MARKER}${t}`;
    }
    setInput("");
    void send([...messages, { role: "user", content }]);
  }

  if (!consent) {
    return (
      <div className="chat-consent">
        <UsageMeter percent={usage} />
        <p>
          和 Claude 對答時，你的作答內容與你輸入的文字會傳送到本站伺服器與 Anthropic（Claude 的開發公司）以產生回覆。
          本站<strong>不記錄對話內容</strong>。Claude 只會「建議」修正，每一項都要你確認才會生效。
        </p>
        <button onClick={() => setConsent(true)} disabled={usageFull}>我了解，開始對答</button>
      </div>
    );
  }

  return (
    <div className="chat">
      <UsageMeter percent={usage} />
      {!started && (
        <div className="starters">
          <p className="muted">選一個主題開始，或直接輸入你的想法：</p>
          {data.discussions.map((d) => (
            <button key={d.id} className="secondary" disabled={usageFull} onClick={() => sendUserText(d.opening, d.id)}>
              {d.title}
            </button>
          ))}
        </div>
      )}

      <div className="chat-log">
        {messages.map((m, i) => (
          <Message key={i} m={m}
            render={(t) => (
              <ToolCard t={t} answers={answers} decision={decisions[t.id]}
                onDecide={(d) => decide(t.id, d)}
                apply={{ ...props, afterSummary }} />
            )} />
        ))}
        {loading && <div className="bubble bubble-assistant muted">Claude 思考中…</div>}
        {error && (
          <div className="error">
            {error}
            {!loading && last?.role === "user" && (
              <button className="link" onClick={() => void send(messages)}>重試</button>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); sendUserText(input); }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={waitingForTools ? "請先回應上面的建議" : "例如：我很在意兒童貧窮，對財團也沒有好感，這會怎麼影響我的結果？"}
          disabled={loading || waitingForTools || usageFull}
          rows={2}
          maxLength={2000}
        />
        <button type="submit" disabled={loading || waitingForTools || usageFull || !input.trim()}>送出</button>
      </form>
    </div>
  );
}

function Message({ m, render }: {
  m: ApiMessage;
  render: (t: ToolUse) => React.ReactNode;
}) {
  if (m.role === "user") {
    if (typeof m.content !== "string") return null; // tool_result 不顯示
    const idx = m.content.indexOf(USER_TEXT_MARKER);
    const text = idx >= 0 ? m.content.slice(idx + USER_TEXT_MARKER.length) : m.content;
    return <div className="bubble bubble-user">{text}</div>;
  }
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content } as ContentBlock] : m.content;
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          return <div key={i} className="bubble bubble-assistant">{b.text}</div>;
        }
        if (isToolUse(b)) return <div key={i}>{render(b)}</div>;
        return null; // thinking 等區塊不顯示，但會原樣保存並送回
      })}
    </>
  );
}

interface ApplyFns extends Props {
  afterSummary: (next: Answers) => string;
}

function ToolCard({ t, answers, decision, onDecide, apply }: {
  t: ToolUse; answers: Answers; decision?: Decision;
  onDecide: (d: Decision) => void; apply: ApplyFns;
}) {
  const qid = String(t.input.question_id ?? "");
  const q = questionById.get(qid);
  if (decision) return <div className="tool-card done small">{decision.label}</div>;
  if (!q) return null;

  if (t.name === "ask_supplementary") {
    return (
      <div className="tool-card">
        <div className="eyebrow">補充題</div>
        <p className="question-sm">{q.text}</p>
        {typeof t.input.why === "string" && <p className="muted small">{t.input.why}</p>}
        <div className="options compact">
          {ANSWER_OPTIONS.map((o) => (
            <button key={String(o.v)} className="option" onClick={() => {
              apply.onSupplementaryAnswer(qid, o.v);
              const next = { ...answers, [qid]: { v: o.v, imp: false } };
              onDecide({
                label: `你回答了「${q.text}」：${o.label}`,
                result: `使用者作答：${o.label}（${o.v === null ? "null" : o.v}）。${afterSummary(apply, next)}`,
              });
            }}>{o.label}</button>
          ))}
          <button className="link" onClick={() => onDecide({ label: "你略過了這題", result: "使用者略過這題。" })}>略過</button>
        </div>
      </div>
    );
  }

  if (t.name === "propose_answer_change") {
    const to = Number(t.input.new_value);
    const from = answers[qid]?.v ?? null;
    const reason = String(t.input.reason ?? "");
    return (
      <div className="tool-card">
        <div className="eyebrow">建議修改作答</div>
        <p className="question-sm">{q.text}</p>
        <p>{answerLabel(from)} → <strong>{answerLabel(to)}</strong></p>
        <p className="muted small">理由：{reason}</p>
        <div className="row">
          <button onClick={() => {
            apply.onAnswerChange(qid, to, reason);
            const next = { ...answers, [qid]: { v: to, imp: answers[qid]?.imp ?? false } };
            onDecide({ label: `已修改：${q.text} → ${answerLabel(to)}`, result: `使用者已確認修改 ${qid}：${from} → ${to}。${afterSummary(apply, next)}` });
          }}>接受</button>
          <button className="secondary" onClick={() => onDecide({ label: "你沒有接受這項修改", result: `使用者拒絕修改 ${qid}。` })}>不接受</button>
        </div>
      </div>
    );
  }

  if (t.name === "propose_importance_change") {
    const imp = Boolean(t.input.important);
    const reason = String(t.input.reason ?? "");
    return (
      <div className="tool-card">
        <div className="eyebrow">建議調整重要度</div>
        <p className="question-sm">{q.text}</p>
        <p>{imp ? "標記為「對我很重要」" : "取消「對我很重要」"}</p>
        <p className="muted small">理由：{reason}</p>
        <div className="row">
          <button onClick={() => {
            apply.onImportanceChange(qid, imp, reason);
            const next = { ...answers, [qid]: { v: answers[qid]?.v ?? null, imp } };
            onDecide({ label: `已調整重要度：${q.text}`, result: `使用者已確認將 ${qid} 的重要度設為 ${imp}。${afterSummary(apply, next)}` });
          }}>接受</button>
          <button className="secondary" onClick={() => onDecide({ label: "你沒有接受這項調整", result: `使用者拒絕調整 ${qid} 的重要度。` })}>不接受</button>
        </div>
      </div>
    );
  }
  return null;
}

function afterSummary(apply: ApplyFns, next: Answers): string {
  return apply.afterSummary(next);
}
