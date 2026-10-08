'use client';

import {
  useVirtualizer,
  type Range,
  type VirtualItem,
  type Virtualizer,
} from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { ChatMessage } from './history-messages';

export type ChatRow = ChatMessage & { streaming?: boolean; working?: boolean };
export type ChatMeasurements = VirtualItem[];

type Props = {
  messages: ChatRow[];
  scrollElementRef: RefObject<HTMLDivElement | null>;
  measurementsRef: RefObject<ChatMeasurements>;
  initialOffset: number;
  initialAtEnd: boolean;
  onScroll: () => void;
  children: (message: ChatRow) => ReactNode;
};

export function VirtualChatThread({
  messages,
  scrollElementRef,
  measurementsRef,
  initialOffset,
  initialAtEnd,
  onScroll,
  children,
}: Props) {
  const pinned = useRef(initialAtEnd);
  const initialMeasurements = useRef(measurementsRef.current);
  const instanceRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  const getItemKey = useCallback((index: number) => messages[index]!.id, [messages]);
  const rangeExtractor = useCallback((range: Range) => {
    const instance = instanceRef.current;
    // Keep both a minimum number of bubbles and two screens on either side.
    // A pixel buffer also covers runs of short user messages.
    const buffer = Math.max(1200, (instance?.scrollRect?.height ?? 600) * 2);
    const offset = instance?.scrollOffset ?? 0;
    const first =
      instance?.getVirtualItemForOffset(Math.max(0, offset - buffer))?.index ?? range.startIndex;
    const last =
      instance?.getVirtualItemForOffset(offset + (instance?.scrollRect?.height ?? 600) + buffer)
        ?.index ?? range.endIndex;
    const start = Math.max(0, Math.min(first, range.startIndex - range.overscan));
    const end = Math.min(range.count - 1, Math.max(last, range.endIndex + range.overscan));
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }, []);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => scrollElementRef.current,
    getItemKey,
    estimateSize: (index) =>
      Math.max(92, Math.min(1600, 72 + Math.ceil(messages[index]!.content.length / 90) * 20)),
    initialOffset,
    initialMeasurementsCache: initialMeasurements.current,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 12,
    rangeExtractor,
    paddingStart: 12,
    paddingEnd: 12,
  });
  instanceRef.current = virtualizer;

  const followEnd = useCallback(() => {
    if (!pinned.current || messages.length === 0) return;
    const lastRow = scrollElementRef.current?.querySelector<HTMLDivElement>(
      `[data-index="${messages.length - 1}"]`,
    );
    if (lastRow) virtualizer.measureElement(lastRow);
    virtualizer.scrollToEnd();
  }, [messages.length, scrollElementRef, virtualizer]);

  useLayoutEffect(() => {
    // Also align on equal-count replacements (Thinking -> message). They are
    // not appends, and preserving a small gap repeatedly can lose end pinning.
    followEnd();
  }, [messages, followEnd]);

  useLayoutEffect(() => {
    const element = scrollElementRef.current;
    if (!element) return;
    let width = element.clientWidth;
    let height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      if (width === element.clientWidth && height === element.clientHeight) return;
      width = element.clientWidth;
      height = element.clientHeight;
      followEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [followEnd, scrollElementRef]);

  useLayoutEffect(
    () => () => {
      virtualizer.getTotalSize();
      measurementsRef.current = virtualizer.measurementsCache;
    },
    [virtualizer, measurementsRef],
  );

  const handleScroll = () => {
    const element = scrollElementRef.current;
    if (element)
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
    onScroll();
  };

  return (
    <div className="chat-thread" ref={scrollElementRef} onScroll={handleScroll}>
      {messages.length === 0 ? <p className="chat-empty">No messages yet.</p> : null}
      <div className="chat-virtual-content" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            data-message-id={messages[item.index]!.id}
            className="chat-virtual-row"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {children(messages[item.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}
