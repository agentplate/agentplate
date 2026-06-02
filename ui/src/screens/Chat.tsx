// Chat screen — talk to the coordinator and submit tasks.
//
// Two write actions over the localhost-only API:
//  - "Chat" POSTs /api/chat → mail to the coordinator.
//  - "Submit task" POSTs /api/tasks → spawns a worker (builder/lead/…).
// The conversation is reconstructed from the live feed (mail to/from operator
// and coordinator), so replies appear as the coordinator works.

import { useMemo, useState } from "react";
import { postChat, postTask } from "../api.ts";
import { Badge, Card, fmtAgo } from "../lib.tsx";
import { IconChat, PageIcon } from "../icons.tsx";
import type { FeedItem } from "../types.ts";

const CAPABILITIES = ["builder", "lead", "scout", "reviewer"] as const;

const textareaStyle: React.CSSProperties = {
	width: "100%",
	background: "var(--bg-input)",
	border: "1px solid var(--border)",
	borderRadius: "9px",
	color: "var(--text)",
	font: "inherit",
	fontSize: "13px",
	padding: "10px 12px",
	resize: "vertical",
	outline: "none",
};

const selectStyle: React.CSSProperties = {
	background: "var(--bg-input)",
	border: "1px solid var(--border)",
	borderRadius: "9px",
	color: "var(--text)",
	font: "inherit",
	fontSize: "13px",
	padding: "7px 10px",
	outline: "none",
};

export function ChatScreen({ feed }: { feed: FeedItem[] }): JSX.Element {
	const [message, setMessage] = useState("");
	const [taskPrompt, setTaskPrompt] = useState("");
	const [capability, setCapability] = useState<string>("builder");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// The conversation: mail items involving the operator or coordinator.
	const conversation = useMemo(
		() =>
			feed.filter(
				(f) =>
					f.kind === "mail" &&
					(f.agent === "operator" ||
						f.agent === "coordinator" ||
						f.summary.includes("coordinator") ||
						f.summary.includes("operator")),
			),
		[feed],
	);

	async function sendChat(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		const text = message.trim();
		if (!text || busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await postChat(text);
			setMessage("");
			setNotice("Message sent to coordinator.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function submitTask(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		const prompt = taskPrompt.trim();
		if (!prompt || busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const res = await postTask({ prompt, capability });
			setTaskPrompt("");
			setNotice(`Task ${res.taskId} accepted — spawning a ${res.capability}.`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div>
			<div className="page-head">
				<h1 className="page-title">
					<PageIcon icon={IconChat} tone="info" /> Chat
				</h1>
				<p className="page-sub">Message the coordinator or submit a task to spawn a worker.</p>
			</div>

			{notice ? (
				<div
					style={{
						background: "var(--ok-soft)",
						border: "1px solid rgba(52,211,153,0.3)",
						color: "var(--ok)",
						borderRadius: "9px",
						padding: "10px 14px",
						marginBottom: "16px",
						fontSize: "13px",
						fontWeight: 600,
					}}
				>
					{notice}
				</div>
			) : null}
			{error ? (
				<div
					style={{
						background: "var(--err-soft)",
						border: "1px solid var(--accent-border)",
						color: "var(--err)",
						borderRadius: "9px",
						padding: "10px 14px",
						marginBottom: "16px",
						fontSize: "13px",
						fontWeight: 600,
					}}
				>
					{error}
				</div>
			) : null}

			<div className="row-2col">
				<Card title="Conversation" meta={`${conversation.length} messages`}>
					{conversation.length === 0 ? (
						<div className="empty">No messages yet. Say hello to the coordinator below.</div>
					) : (
						<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
							{conversation.map((m, i) => (
								<li
									key={`${m.ts}-${i}`}
									style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 12, borderBottom: "1px solid var(--border-soft)" }}
								>
									<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
										<span className="mono" style={{ fontWeight: 600 }}>
											{m.agent}
										</span>
										<span className="faint" style={{ fontSize: 12 }}>
											{fmtAgo(m.ts)}
										</span>
									</div>
									<span className="dim">{m.detail ?? m.summary}</span>
								</li>
							))}
						</ul>
					)}
				</Card>

				<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
					<Card title="Message the coordinator">
						<form onSubmit={sendChat} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
							<textarea
								style={textareaStyle}
								placeholder="e.g. Build a REST API for a todo app, then deploy it."
								value={message}
								onChange={(e) => setMessage(e.target.value)}
								rows={3}
							/>
							<div style={{ display: "flex", justifyContent: "flex-end" }}>
								<button type="submit" className="btn primary" disabled={busy || !message.trim()}>
									Send
								</button>
							</div>
						</form>
					</Card>

					<Card title="Submit a task" meta="spawns a worker">
						<form onSubmit={submitTask} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
							<textarea
								style={textareaStyle}
								placeholder="Describe the task for a worker agent…"
								value={taskPrompt}
								onChange={(e) => setTaskPrompt(e.target.value)}
								rows={3}
							/>
							<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
								<label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 13 }}>
									Capability
									<select
										style={selectStyle}
										value={capability}
										onChange={(e) => setCapability(e.target.value)}
									>
										{CAPABILITIES.map((c) => (
											<option key={c} value={c}>
												{c}
											</option>
										))}
									</select>
								</label>
								<Badge tone="accent">{capability}</Badge>
								<div style={{ flex: 1 }} />
								<button type="submit" className="btn" disabled={busy || !taskPrompt.trim()}>
									Submit task
								</button>
							</div>
						</form>
					</Card>
				</div>
			</div>
		</div>
	);
}
