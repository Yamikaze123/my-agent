"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DefaultChatTransport, type ToolUIPart, type UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { FinanceDatasetControls } from "@/components/finance/dataset-controls";
import { FinanceAnalysisResult } from "@/components/finance/analysis-result";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  isAbortError,
  requestJson,
  responseError,
} from "@/components/finance/api-request";
import {
  EMPTY_PANEL_RESULTS,
  MAX_PANEL_RESULTS,
  appendPanelResult,
  buildTimeline,
  loadPanelResults,
  savePanelResults,
  type PanelResultsState,
} from "@/components/finance/panel-results";
import {
  financeAnalysisFromOutput,
  toolOutputImages,
} from "@/components/finance/tool-output";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";

import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ArrowUpIcon,
  BarChart3Icon,
  BrainCircuitIcon,
  DatabaseIcon,
  FileSpreadsheetIcon,
  LineChartIcon,
  Loader2Icon,
  PlusIcon,
  SparklesIcon,
  Table2Icon,
} from "lucide-react";

const SUGGESTED_PROMPTS = [
  {
    label: "Market snapshot",
    description: "Track a company and surface the numbers that matter.",
    prompt:
      "Fetch the last 100 days of Apple's stock closing prices. Plot a line chart and calculate the average, median, variability, lowest price, and highest price.",
    icon: LineChartIcon,
  },
  {
    label: "Compare performance",
    description: "Put two time series side by side and test the difference.",
    prompt:
      "Compare the monthly stock performance of Tesla and Microsoft over the past year. Plot both series on the same chart and assess whether their performance differs meaningfully.",
    icon: BarChart3Icon,
  },
  {
    label: "Profile a dataset",
    description: "Understand shape, types, missing values, and distributions.",
    prompt:
      "Profile the complete synthetic finance fixture using its default ticker and date selection: show its date range, tickers, missing values, summary statistics, and a visualization of the adjusted-close prices.",
    icon: FileSpreadsheetIcon,
  },
  {
    label: "Find patterns",
    description: "Explore clusters and relationships with a clear visual.",
    prompt:
      "Compare the relationship between daily returns for two finance tickers (AAPL and MSFT), visualize the result, and explain the limitations of the analysis.",
    icon: BrainCircuitIcon,
  },
  {
    label: "Write Python",
    description: "Start with a small script and build from there.",
    prompt:
      "Calculate and visualize a simple rolling average for a finance time series, then explain the result in plain language.",
    icon: Table2Icon,
  },
] as const;

const CAPABILITIES = [
  { label: "Python-powered", icon: BrainCircuitIcon },
  { label: "Charts included", icon: BarChart3Icon },
  { label: "Governed finance data", icon: DatabaseIcon },
] as const;

const MAX_HISTORY_AUTH_RECOVERY_ATTEMPTS = 1;
const DEFAULT_CHAT_ERROR =
  "The analysis could not be completed. Please try again.";
const NEW_CHAT_ERROR = "A new analysis could not be started. Please try again.";
const WORKING_LABEL = "Working on your analysis…";

// A rejected request surfaces the response body as the error message. The API
// returns JSON such as {"error": "...", "code": "..."}; show its text rather
// than the raw payload.
function chatErrorMessage(error: Error): string {
  const raw = error.message?.trim();
  if (!raw) return DEFAULT_CHAT_ERROR;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string" &&
      parsed.error.trim()
    ) {
      return parsed.error;
    }
    return DEFAULT_CHAT_ERROR;
  } catch {
    return raw;
  }
}

function ToolImages({ images }: { images: string[] }) {
  if (images.length === 0) return null;

  return (
    <div className="my-3 flex flex-col gap-3">
      {images.map((base64, idx) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={idx}
          src={`data:image/png;base64,${base64}`}
          alt={`Generated plot ${idx + 1}`}
          className="max-w-full rounded-xl border border-border/70 bg-background shadow-sm"
        />
      ))}
    </div>
  );
}

function ChatMessageParts({ message }: { message: UIMessage }) {
  return (
    <div className="space-y-2">
      {message.parts?.map((part, i) => {
        if (part.type === "text") {
          const isUser = message.role === "user";

          return (
            <Message
              key={`${message.id}-${i}`}
              from={message.role}
              className={isUser ? "max-w-[88%]" : "max-w-full"}
            >
              {!isUser && (
                <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span className="flex size-5 items-center justify-center rounded-md bg-foreground text-background">
                    <SparklesIcon className="size-3" />
                  </span>
                  Data Studio
                </div>
              )}
              <MessageContent
                className={
                  isUser
                    ? "rounded-2xl rounded-br-md px-4 py-3"
                    : "max-w-3xl leading-7"
                }
              >
                <MessageResponse>{part.text}</MessageResponse>
              </MessageContent>
            </Message>
          );
        }

        if (part.type?.startsWith("tool-")) {
          const toolPart = part as ToolUIPart;
          const financeResult = financeAnalysisFromOutput(toolPart.output);
          const isToolError = toolPart.state === "output-error";

          return (
            <div key={`${message.id}-${i}`} className="max-w-full sm:ml-7">
              {/* The details stay collapsed unless the call failed; the key
                  remounts the panel so a failure opens it. */}
              <Tool
                key={isToolError ? "error" : "details"}
                defaultOpen={isToolError}
                className="rounded-2xl border-border/70 bg-muted/20 shadow-none"
              >
                <ToolHeader
                  type={toolPart.type}
                  state={toolPart.state || "output-available"}
                  className="px-4"
                />
                <ToolContent>
                  <ToolInput input={toolPart.input || {}} />
                  {!financeResult && (
                    <ToolOutput
                      output={toolPart.output}
                      errorText={toolPart.errorText}
                    />
                  )}
                </ToolContent>
              </Tool>
              {financeResult && (
                <FinanceAnalysisResult result={financeResult} />
              )}
              <ToolImages images={toolOutputImages(toolPart.output)} />
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

export default function Home() {
  const [input, setInput] = useState<string>("");
  const [isResetting, setIsResetting] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const [isDatasetPanelOpen, setIsDatasetPanelOpen] = useState(false);
  const [isFinanceActionPending, setIsFinanceActionPending] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [panelResults, setPanelResults] =
    useState<PanelResultsState>(EMPTY_PANEL_RESULTS);
  const hasStartedMessageRef = useRef(false);
  const wasChatBusyRef = useRef(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    error: chatError,
    clearError,
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // The server keeps the conversation in memory, so send only the new
      // message. Resending the history (with every chart image) would grow
      // each request until the server refused it.
      prepareSendMessagesRequest: ({ messages: outgoing }) => ({
        body: { messages: outgoing.slice(-1) },
      }),
    }),
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const fetchMessages = async () => {
      const storedPanelResults = loadPanelResults();
      let sessionWasReplaced = false;
      try {
        for (
          let attempt = 0;
          attempt <= MAX_HISTORY_AUTH_RECOVERY_ATTEMPTS;
          attempt += 1
        ) {
          const {
            ok,
            status: httpStatus,
            payload,
          } = await requestJson("/api/chat", {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
            timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
            timeoutMessage:
              "Loading the conversation took too long. Reload the page to try again.",
          });

          // A 401 response expires stale legacy/session cookies. Retry once so
          // the API can issue a fresh anonymous session without user action.
          if (
            httpStatus === 401 &&
            attempt < MAX_HISTORY_AUTH_RECOVERY_ATTEMPTS
          ) {
            sessionWasReplaced = true;
            continue;
          }

          if (!ok) {
            throw new Error(
              responseError(payload, "Unable to load the conversation."),
            );
          }

          if (!Array.isArray(payload)) {
            throw new Error("The conversation history response was invalid.");
          }

          if (!cancelled) {
            setHistoryError(null);
            // Never replace a conversation the user has already started.
            if (!hasStartedMessageRef.current) {
              setMessages(payload);
            }
            // Panel results belong to the session they were run in.
            setPanelResults(
              sessionWasReplaced ? EMPTY_PANEL_RESULTS : storedPanelResults,
            );
          }
          return;
        }
      } catch (error) {
        if (cancelled || isAbortError(error)) return;
        console.error("Unable to load chat history", error);
        setHistoryError(
          error instanceof Error
            ? error.message
            : "Unable to load the conversation.",
        );
        setPanelResults(storedPanelResults);
      } finally {
        if (!cancelled) setIsHistoryLoading(false);
      }
    };

    fetchMessages();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [setMessages]);

  // Keep panel results for this browser session once the stored ones have
  // been read (writing earlier would overwrite them with the empty default).
  useEffect(() => {
    if (isHistoryLoading) return;
    savePanelResults(panelResults);
  }, [isHistoryLoading, panelResults]);

  const isChatBusy = status === "submitted" || status === "streaming";
  const isGenerating = isChatBusy || isFinanceActionPending;
  // Nothing new may be sent while a reply, a panel action, a reset or the
  // initial history load is in flight.
  const isSendBlocked = isGenerating || isResetting || isHistoryLoading;
  const canSendInput = !isSendBlocked && input.trim() !== "";

  // Return keyboard focus to the composer when a reply finishes, unless the
  // user has moved focus somewhere else in the meantime.
  useEffect(() => {
    if (wasChatBusyRef.current && !isChatBusy) {
      const active = document.activeElement;
      if (
        !active ||
        active === document.body ||
        composerRef.current?.contains(active)
      ) {
        textareaRef.current?.focus();
      }
    }
    wasChatBusyRef.current = isChatBusy;
  }, [isChatBusy]);

  const handleSubmit = async (text?: string) => {
    const msg = text || input;
    if (isSendBlocked || !msg.trim()) return;

    hasStartedMessageRef.current = true;
    clearError();
    setNewChatError(null);
    sendMessage({ text: msg });
    setInput("");
  };

  const handleNewChat = async () => {
    setIsResetting(true);
    setNewChatError(null);

    try {
      const { ok, payload } = await requestJson("/api/chat", {
        method: "DELETE",
        credentials: "same-origin",
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        timeoutMessage: NEW_CHAT_ERROR,
      });
      if (!ok) {
        throw new Error(responseError(payload, NEW_CHAT_ERROR));
      }

      setMessages([]);
      setPanelResults(EMPTY_PANEL_RESULTS);
      setInput("");
      clearError();
    } catch (error) {
      console.error("Unable to start a new chat", error);
      setNewChatError(error instanceof Error ? error.message : NEW_CHAT_ERROR);
    } finally {
      setIsResetting(false);
    }
  };

  const isEmpty = messages.length === 0 && panelResults.entries.length === 0;
  const timeline = useMemo(
    () => buildTimeline(messages, panelResults.entries),
    [messages, panelResults.entries],
  );

  return (
    <main className="min-h-dvh bg-[#f4f4f2] p-3 text-foreground sm:p-5 dark:bg-zinc-950">
      <div className="mx-auto flex h-[calc(100dvh-1.5rem)] w-full max-w-[1480px] flex-col overflow-hidden rounded-[26px] border border-zinc-200/80 bg-background shadow-[0_24px_80px_-36px_rgba(24,24,27,0.35)] sm:h-[calc(100dvh-2.5rem)] dark:border-zinc-800 dark:shadow-black/30">
        <header className="flex shrink-0 items-center justify-between border-b border-border/70 bg-background/90 px-4 py-3.5 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background shadow-sm">
              <BarChart3Icon className="size-[18px]" strokeWidth={2.25} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-[-0.01em]">
                Data Studio
              </p>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">
                Your AI analysis workspace
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge
              className="hidden gap-1.5 border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700 sm:inline-flex dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
              variant="outline"
            >
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Analysis mode
            </Badge>
            {!isEmpty && !isHistoryLoading && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleNewChat}
                disabled={isGenerating || isResetting}
                className="h-8 gap-1.5 rounded-lg bg-background px-2.5 shadow-none sm:px-3"
              >
                <PlusIcon className="size-3.5" />
                <span className="hidden sm:inline">
                  {isResetting ? "Starting..." : "New analysis"}
                </span>
                <span className="sm:hidden">New</span>
              </Button>
            )}
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {historyError && (
            <div className="mx-auto w-full max-w-3xl px-4 pt-4 sm:px-6 md:px-0">
              <Alert variant="destructive">
                <AlertTitle>Unable to load chat history</AlertTitle>
                <AlertDescription>{historyError}</AlertDescription>
              </Alert>
            </div>
          )}
          {isHistoryLoading ? (
            <div
              className="flex flex-1 items-center justify-center gap-2 px-4 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              Loading your conversation…
            </div>
          ) : isEmpty ? (
            <section className="relative flex flex-1 flex-col items-center overflow-y-auto px-4 pb-8 pt-12 sm:px-8 sm:pt-16">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(59,130,246,0.10),transparent_34%)]" />
              <div className="relative z-10 flex w-full max-w-5xl flex-col items-center">
                <Badge
                  className="mb-5 gap-1.5 border-blue-200/80 bg-blue-50/80 px-3 py-1 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
                  variant="outline"
                >
                  <SparklesIcon className="size-3.5" />
                  AI-powered data analysis
                </Badge>

                <h1 className="max-w-3xl text-center text-4xl font-semibold tracking-[-0.055em] text-foreground sm:text-5xl md:text-6xl">
                  Ask better questions of your data.
                </h1>
                <p className="mt-5 max-w-2xl text-center text-base leading-7 text-muted-foreground sm:text-lg">
                  Explore patterns, create visualizations, and turn raw numbers
                  into clear insights with a Python-powered analysis partner.
                </p>

                <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
                  {CAPABILITIES.map(({ icon: Icon, label }) => (
                    <div
                      key={label}
                      className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-background/75 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur"
                    >
                      <Icon className="size-3.5 text-foreground/70" />
                      {label}
                    </div>
                  ))}
                </div>

                <div className="mt-12 grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {SUGGESTED_PROMPTS.map((suggestion) => {
                    const Icon = suggestion.icon;

                    return (
                      <Card
                        key={suggestion.label}
                        size="sm"
                        className="group h-full bg-background/85 p-0 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md"
                      >
                        <button
                          type="button"
                          onClick={() => handleSubmit(suggestion.prompt)}
                          disabled={isSendBlocked}
                          className="flex h-full min-h-[156px] w-full flex-col justify-between p-5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
                              <Icon className="size-4" />
                            </div>
                            <ArrowUpIcon className="size-4 rotate-45 text-muted-foreground/60 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
                          </div>
                          <div className="mt-8">
                            <p className="text-sm font-semibold tracking-[-0.01em]">
                              {suggestion.label}
                            </p>
                            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                              {suggestion.description}
                            </p>
                          </div>
                        </button>
                      </Card>
                    );
                  })}
                </div>
              </div>
            </section>
          ) : (
            <Conversation className="h-full">
              <ConversationContent className="mx-auto w-full max-w-3xl gap-7 px-4 py-8 sm:px-6 md:px-0">
                {panelResults.droppedCount > 0 && (
                  <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground sm:ml-7">
                    Only the {MAX_PANEL_RESULTS} most recent results run from
                    the Finance data panel are kept.{" "}
                    {panelResults.droppedCount === 1
                      ? "1 older result is"
                      : `${panelResults.droppedCount} older results are`}{" "}
                    no longer shown.
                  </p>
                )}
                {timeline.map((item) =>
                  item.kind === "message" ? (
                    <ChatMessageParts
                      key={item.message.id}
                      message={item.message}
                    />
                  ) : (
                    <div
                      key={`panel-${item.entry.result.runId}`}
                      className="max-w-full sm:ml-7"
                    >
                      <FinanceAnalysisResult result={item.entry.result} />
                    </div>
                  ),
                )}
                {status === "submitted" && (
                  // Announced through the live region beside the composer.
                  <div
                    aria-hidden="true"
                    className="flex items-center gap-2 text-sm text-muted-foreground sm:ml-7"
                  >
                    <Loader2Icon className="size-4 animate-spin" />
                    {WORKING_LABEL}
                  </div>
                )}
                <ConversationScrollButton />
              </ConversationContent>
            </Conversation>
          )}

          <div className="shrink-0 border-t border-border/70 bg-background/90 px-4 py-4 backdrop-blur sm:px-6 md:py-5 [@media(max-height:560px)]:py-2!">
            <div ref={composerRef} className="mx-auto w-full max-w-3xl">
              <p className="sr-only" role="status" aria-live="polite">
                {status === "submitted" ? WORKING_LABEL : ""}
              </p>
              {(chatError || newChatError) && (
                <Alert variant="destructive" className="mb-3">
                  <AlertTitle>
                    {chatError
                      ? "The request was not completed"
                      : "Unable to start a new analysis"}
                  </AlertTitle>
                  <AlertDescription>
                    <p>
                      {chatError ? chatErrorMessage(chatError) : newChatError}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2 h-7 bg-background px-2.5 text-foreground shadow-none"
                      onClick={() => {
                        clearError();
                        setNewChatError(null);
                      }}
                    >
                      Dismiss
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              <FinanceDatasetControls
                open={isDatasetPanelOpen}
                onOpenChange={setIsDatasetPanelOpen}
                onResult={(result) => {
                  const messageCount = messages.length;
                  setPanelResults((current) =>
                    appendPanelResult(current, result, messageCount),
                  );
                }}
                onBusyChange={setIsFinanceActionPending}
                disabled={isGenerating || isResetting}
              />
              <PromptInput
                onSubmit={({ text }) => handleSubmit(text)}
                className="[&>[data-slot=input-group]]:rounded-2xl [&>[data-slot=input-group]]:border-border/80 [&>[data-slot=input-group]]:bg-background [&>[data-slot=input-group]]:shadow-[0_8px_30px_-18px_rgba(24,24,27,0.35)]"
              >
                <PromptInputBody>
                  {/* Stays enabled while a reply is generated so keyboard
                      focus is kept and the next question can be drafted;
                      sending is blocked instead. */}
                  <PromptInputTextarea
                    ref={textareaRef}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing &&
                        !canSendInput
                      ) {
                        e.preventDefault();
                      }
                    }}
                    className="min-h-[68px] px-4 pb-2 pt-4 text-[15px] leading-6 placeholder:text-muted-foreground/70 [@media(max-height:560px)]:min-h-[44px]! [@media(max-height:560px)]:pt-2!"
                    value={input}
                    placeholder="Ask anything about your data..."
                    readOnly={isResetting}
                  />
                </PromptInputBody>
                <PromptInputFooter className="border-t border-border/60 px-3 py-2">
                  <PromptInputTools>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <DatabaseIcon className="size-3.5" />
                      <span className="hidden sm:inline">Python workspace</span>
                      <span className="sm:hidden">Ready</span>
                    </div>
                    <span className="hidden text-xs text-muted-foreground/70 sm:inline">
                      Enter to send · Shift + Enter for a new line
                    </span>
                  </PromptInputTools>
                  <PromptInputSubmit
                    status={status}
                    onStop={stop}
                    // While a reply is generated this is the stop button.
                    disabled={!isChatBusy && !canSendInput}
                    aria-label={isChatBusy ? "Stop analysis" : "Send message"}
                    className="rounded-xl bg-foreground text-background hover:bg-foreground/85"
                  />
                </PromptInputFooter>
              </PromptInput>
              <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
                AI-generated analysis can be incorrect. Check important results
                before using them.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
