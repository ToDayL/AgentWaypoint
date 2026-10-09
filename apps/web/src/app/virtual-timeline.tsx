'use client';

import {
  useVirtualizer,
  type Range,
  type VirtualItem,
  type Virtualizer,
} from '@tanstack/react-virtual';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

const BOTTOM_THRESHOLD = 48;

export type TimelineScrollState = {
  scopeKey: string;
  offset: number;
  atEnd: boolean;
  measurements: VirtualItem[];
};

type Props<T> = {
  events: T[];
  scopeKey: string;
  scrollStateRef: RefObject<TimelineScrollState | null>;
  loading: boolean;
  debugLabel?: string;
  children: (event: T) => ReactNode;
};

export function VirtualTimeline<T extends { id: string }>({
  events,
  scopeKey,
  scrollStateRef,
  loading,
  debugLabel,
  children,
}: Props<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const initialState = useRef(
    scrollStateRef.current?.scopeKey === scopeKey ? scrollStateRef.current : null,
  );
  const position = useRef({
    offset: initialState.current?.offset ?? 0,
    atEnd: initialState.current?.atEnd ?? true,
  });
  const instanceRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  const getItemKey = useCallback((index: number) => events[index]!.id, [events]);
  const rangeExtractor = useCallback((range: Range) => {
    const instance = instanceRef.current;
    const viewport = instance?.scrollRect?.height ?? 600;
    const buffer = Math.max(1200, viewport * 2);
    const offset = instance?.scrollOffset ?? 0;
    const first =
      instance?.getVirtualItemForOffset(Math.max(0, offset - buffer))?.index ?? range.startIndex;
    const last =
      instance?.getVirtualItemForOffset(offset + viewport + buffer)?.index ?? range.endIndex;
    const start = Math.max(0, Math.min(first, range.startIndex - range.overscan));
    const end = Math.min(range.count - 1, Math.max(last, range.endIndex + range.overscan));
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }, []);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: loading ? 0 : events.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 74,
    initialOffset: initialState.current?.offset ?? 0,
    initialMeasurementsCache: initialState.current?.measurements,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: BOTTOM_THRESHOLD,
    gap: 4,
    overscan: 12,
    rangeExtractor,
    scrollMargin,
  });
  instanceRef.current = virtualizer;

  const followEnd = useCallback(() => {
    if (!position.current.atEnd || loading || events.length === 0) return;
    const lastRow = scrollRef.current?.querySelector<HTMLDivElement>(
      `[data-index="${events.length - 1}"]`,
    );
    if (lastRow) virtualizer.measureElement(lastRow);
    virtualizer.scrollToEnd();
  }, [events.length, loading, virtualizer]);

  useLayoutEffect(() => {
    // Status and output updates can resize existing events without appending.
    followEnd();
  }, [events, scrollMargin, followEnd]);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const update = () => setScrollMargin(header.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
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
  }, [followEnd]);

  useLayoutEffect(
    () => () => {
      virtualizer.getTotalSize();
      scrollStateRef.current = {
        scopeKey,
        ...position.current,
        measurements: virtualizer.measurementsCache,
      };
    },
    [scopeKey, scrollStateRef, virtualizer],
  );

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    position.current = {
      offset: element.scrollTop,
      atEnd: element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_THRESHOLD,
    };
  };

  return (
    <div className="timeline-list" ref={scrollRef} onScroll={handleScroll}>
      <div ref={headerRef}>
        {debugLabel ? <p className="timeline-empty">{debugLabel}</p> : null}
        {loading ? <p className="timeline-empty">Loading timeline...</p> : null}
        {!loading && events.length === 0 ? <p className="timeline-empty">No events yet.</p> : null}
      </div>
      <div className="timeline-virtual-spacer" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            data-timeline-event-id={events[item.index]!.id}
            className="timeline-virtual-row"
            style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
          >
            {children(events[item.index]!)}
          </div>
        ))}
      </div>
    </div>
  );
}
