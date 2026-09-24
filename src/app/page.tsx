"use client";

import "@/app/globals.css";
import { useEffect, useState } from "react";
import { DefaultChatTransport, ToolUIPart } from "ai";
import { useChat } from "@ai-sdk/react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";

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

function ToolImages({ output }: { output: Record<string, unknown> }) {
  const images = output?.images as string[] | undefined;
  if (!images || images.length === 0) return null;

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

export default function Home() {
  const [input, setInput] = useState<string>("");
  const [isResetting, setIsResetting] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const { messages, setMessages, sendMessage, status, stop, clearError } =
    useChat({
      transport: new DefaultChatTransport({
        api: "/api/chat",
      }),
    });

  useEffect(() => {
    let cancelled = false;

    const fetchMessages = async () => {
      try {
        for (
          let attempt = 0;
          attempt <= MAX_HISTORY_AUTH_RECOVERY_ATTEMPTS;
          attempt += 1
        ) {
          const res = await fetch("/api/chat", {
            cache: "no-store",
            credentials: "same-origin",
          });
          const data: unknown = await res.json();

          // A 401 response expires stale legacy/session cookies. Retry once so
          // the API can issue a fresh anonymous session without user action.
          if (
            res.status === 401 &&
            attempt < MAX_HISTORY_AUTH_RECOVERY_ATTEMPTS
          ) {
            continue;
          }

          if (!res.ok) {
            const message =
              typeof data === "object" &&
              data !== null &&
              "error" in data &&
              typeof data.error === "string"
                ? data.error
                : "Unable to load the conversation.";
            throw new Error(message);
          }

          if (!Array.isArray(data)) {
            throw new Error("The conversation history response was invalid.");
          }

          if (!cancelled) {
            setHistoryError(null);
            setMessages(data);
          }
          return;
        }
      } catch (error) {
        console.error("Unable to load chat history", error);
        if (!cancelled) {
          setHistoryError(
            error instanceof Error
              ? error.message
              : "Unable to load the conversation.",
          );
        }
      }
    };

    fetchMessages();

    return () => {
      cancelled = true;
    };
  }, [setMessages]);

  const handleSubmit = async (text?: string) => {
    const msg = text || input;
    if (!msg.trim()) return;

    sendMessage({ text: msg });
    setInput("");
  };

  const handleNewChat = async () => {
    setIsResetting(true);

    try {
      const response = await fetch("/api/chat", { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Unable to start a new chat");
      }

      setMessages([]);
      setInput("");
      clearError();
    } catch (error) {
      console.error("Unable to start a new chat", error);
    } finally {
      setIsResetting(false);
    }
  };

  const isEmpty = messages.length === 0;
  const isGenerating = status === "submitted" || status === "streaming";

  return (
    <main className="min-h-screen bg-[#f4f4f2] p-3 text-foreground sm:p-5 dark:bg-zinc-950">
      <div className="mx-auto flex h-[calc(100vh-1.5rem)] min-h-[620px] w-full max-w-[1480px] flex-col overflow-hidden rounded-[26px] border border-zinc-200/80 bg-background shadow-[0_24px_80px_-36px_rgba(24,24,27,0.35)] sm:h-[calc(100vh-2.5rem)] dark:border-zinc-800 dark:shadow-black/30">
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
            {!isEmpty && (
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
          {isEmpty ? (
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
                          disabled={isGenerating || isResetting}
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
                {messages.map((message) => (
                  <div key={message.id} className="space-y-2">
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
                        const toolOutput =
                          typeof toolPart.output === "object" &&
                          toolPart.output !== null
                            ? (toolPart.output as Record<string, unknown>)
                            : {};

                        return (
                          <div
                            key={`${message.id}-${i}`}
                            className="max-w-full sm:ml-7"
                          >
                            <Tool className="rounded-2xl border-border/70 bg-muted/20 shadow-none">
                              <ToolHeader
                                type={toolPart.type}
                                state={toolPart.state || "output-available"}
                                className="px-4"
                              />
                              <ToolContent>
                                <ToolInput input={toolPart.input || {}} />
                                <ToolOutput
                                  output={toolPart.output}
                                  errorText={toolPart.errorText}
                                />
                              </ToolContent>
                            </Tool>
                            <ToolImages output={toolOutput} />
                          </div>
                        );
                      }

                      return null;
                    })}
                  </div>
                ))}
                <ConversationScrollButton />
              </ConversationContent>
            </Conversation>
          )}

          <div className="shrink-0 border-t border-border/70 bg-background/90 px-4 py-4 backdrop-blur sm:px-6 md:py-5">
            <div className="mx-auto w-full max-w-3xl">
              <PromptInput
                onSubmit={({ text }) => handleSubmit(text)}
                className="[&>[data-slot=input-group]]:rounded-2xl [&>[data-slot=input-group]]:border-border/80 [&>[data-slot=input-group]]:bg-background [&>[data-slot=input-group]]:shadow-[0_8px_30px_-18px_rgba(24,24,27,0.35)]"
              >
                <PromptInputBody>
                  <PromptInputTextarea
                    onChange={(e) => setInput(e.target.value)}
                    className="min-h-[68px] px-4 pb-2 pt-4 text-[15px] leading-6 placeholder:text-muted-foreground/70"
                    value={input}
                    placeholder="Ask anything about your data..."
                    disabled={isGenerating || isResetting}
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
                    disabled={isResetting}
                    aria-label={isGenerating ? "Stop analysis" : "Send message"}
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
