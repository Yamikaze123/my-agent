"use client";

import "@/app/globals.css";
import { useEffect, useState } from "react";
import { DefaultChatTransport, ToolUIPart } from "ai";
import { useChat } from "@ai-sdk/react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
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

const SUGGESTED_PROMPTS = [
  "Create a python program to print 'Hello World'",
  "Fetch the last 100 days of Apple (AAPL) stock closing prices. Plot a line chart and calculate mean, median, standard deviation, min, and max price.",
  "Compare the monthly returns of Tesla (TSLA) and Microsoft (MSFT) over the past year. Show both on the same chart and run a t-test.",
  "Generate a sample dataset of 200 students with name, age, grade, and GPA. Show the first 5 rows, data types, missing values, and a histogram of GPA.",
  "Create a scatter plot of 500 random points from a 2D normal distribution. Color them by cluster using KMeans with 3 clusters.",
];

function ToolImages({ output }: { output: Record<string, unknown> }) {
  const images = output?.images as string[] | undefined;
  if (!images || images.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 my-3">
      {images.map((base64, idx) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={idx}
          src={`data:image/png;base64,${base64}`}
          alt={`Generated plot ${idx + 1}`}
          className="max-w-full rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-sm"
        />
      ))}
    </div>
  );
}

export default function Home() {
  const [input, setInput] = useState<string>("");

  const { messages, setMessages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
    }),
  });

  useEffect(() => {
    const fetchMessages = async () => {
      const res = await fetch("/api/chat");
      const data = await res.json();
      setMessages([...data]);
    };
    fetchMessages();
  }, [setMessages]);

  const handleSubmit = async (text?: string) => {
    const msg = text || input;
    if (!msg.trim()) return;

    sendMessage({ text: msg });
    setInput("");
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="relative size-full h-screen w-full p-6">
      <div className="flex h-full flex-col">
        {isEmpty && (
          <div className="flex flex-col items-center justify-center flex-1 gap-6 pb-8">
            <div className="text-center">
              <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
                AI Data Analysis
              </h1>
              <p className="text-zinc-500 dark:text-zinc-400 max-w-md">
                Ask me to analyze data, create visualizations, compute
                statistics, or explore financial data.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-2xl w-full">
              {SUGGESTED_PROMPTS.map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSubmit(prompt)}
                  disabled={status !== "ready"}
                  className="text-left p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        <Conversation className="h-full">
          <ConversationContent>
            {messages.map((message) => (
              <div key={message.id}>
                {message.parts?.map((part, i) => {
                  if (part.type === "text") {
                    return (
                      <Message key={`${message.id}-${i}`} from={message.role}>
                        <MessageContent>
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
                      <div key={`${message.id}-${i}`}>
                        <Tool>
                          <ToolHeader
                            type={toolPart.type}
                            state={toolPart.state || "output-available"}
                            className="cursor-pointer"
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

        <PromptInput onSubmit={() => handleSubmit()} className="mt-20">
          <PromptInputBody>
            <PromptInputTextarea
              onChange={(e) => setInput(e.target.value)}
              className="md:leading-10"
              value={input}
              placeholder="Describe your data analysis request..."
              disabled={status !== "ready"}
            />
          </PromptInputBody>
        </PromptInput>
      </div>
    </div>
  );
}
