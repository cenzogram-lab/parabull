import { CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, type IChartApi, type ISeriesApi, type MouseEventParams, type UTCTimestamp } from "lightweight-charts";
import { CandlestickChart } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isDemo } from "../../config";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { tradeCandles } from "../../lib/indexer";
import { compact, pct, price, usdCompact } from "../../lib/format";
import type { Coin } from "../../lib/types";
import { candles, INTERVALS, type Interval } from "../../mock/market";
import { useMarket } from "../../state/Market";
import { hex } from "../../theme/tokens";
import { cx, Segmented } from "../ui/primitives";

const SUPPLY = 1e9;
type Unit = "Price" | "MCap";
type Ohlc = { open: number; high: number; low: number; close: number };

/**
 * Options that differ on phones: a vertical swipe scrolls the page instead of
 * the chart (horizontal drags still pan it), and a little more headroom keeps
 * the top candles clear of the readout.
 */
const touchOptions = (mobile: boolean) => ({
  handleScroll: { vertTouchDrag: !mobile },
  rightPriceScale: { scaleMargins: { top: mobile ? 0.16 : 0.1, bottom: 0.24 } },
});

/**
 * Candles: amber-gold up, bronze-red down (with a lighter edge so bodies clear
 * 3:1 on the surface). Volume sits in its own band under the price, on its own
 * scale, never as a second y-axis. The OHLC readout follows the crosshair.
 */
export function PriceChart({ coin }: { coin: Coin }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [iv, setIv] = useState<Interval>("5m");
  const [unit, setUnit] = useState<Unit>("MCap");
  const scale = unit === "MCap" ? SUPPLY : 1;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  // Demo: generated candles per coin and interval, live trades only move the last bar. Chain mode: candles from the
  // coin's indexed trades, rebuilt as trades arrive.
  const { tradesFor } = useMarket();
  const trades = isDemo ? null : tradesFor(coin.mint);
  const data = useMemo(() => (trades ? tradeCandles(trades, INTERVALS[iv], coin) : candles(coin, iv)), [coin.mint, iv, trades]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hover, setHover] = useState<Ohlc | null>(null);
  const isMobile = useIsMobile();
  // The layout the chart was created for; options change only when it flips.
  const mobileRef = useRef(isMobile);

  useEffect(() => {
    if (!box.current) return;
    const touch = touchOptions(mobileRef.current);
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: hex.surface }, textColor: hex.muted, fontFamily: "Inter Variable, Inter, sans-serif", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "rgba(74,53,40,0.35)" }, horzLines: { color: "rgba(74,53,40,0.35)" } },
      handleScroll: touch.handleScroll,
      rightPriceScale: { borderColor: hex.line, ...touch.rightPriceScale },
      timeScale: { borderColor: hex.line, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: hex.lineAccent, labelBackgroundColor: hex.surface3, width: 1 },
        horzLine: { color: hex.lineAccent, labelBackgroundColor: hex.surface3, width: 1 },
      },
    });
    const cs = c.addSeries(CandlestickSeries, {
      upColor: hex.up,
      downColor: hex.down,
      borderUpColor: hex.up,
      borderDownColor: hex.downEdge,
      wickUpColor: hex.up,
      wickDownColor: hex.downEdge,
      priceLineColor: hex.copper,
    });
    const vs = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const onMove = (p: MouseEventParams) => {
      const d = p.time !== undefined ? (p.seriesData.get(cs) as Ohlc | undefined) : undefined;
      const s = scaleRef.current;
      setHover(d ? { open: d.open / s, high: d.high / s, low: d.low / s, close: d.close / s } : null);
    };
    c.subscribeCrosshairMove(onMove);
    chart.current = c;
    candleSeries.current = cs;
    volSeries.current = vs;
    return () => {
      c.unsubscribeCrosshairMove(onMove);
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (mobileRef.current === isMobile) return;
    mobileRef.current = isMobile;
    chart.current?.applyOptions(touchOptions(isMobile));
  }, [isMobile]);

  useEffect(() => {
    const cs = candleSeries.current;
    const vs = volSeries.current;
    if (!cs || !vs) return;
    // The volume band's bottom margin stretches the price axis below zero; on a phone those ticks get no label rather than a negative price.
    cs.applyOptions({ priceFormat: { type: "custom", minMove: 1e-12, formatter: (v: number) => (mobileRef.current && v < 0 ? "" : unit === "MCap" ? usdCompact(v) : price(v)) } });
    cs.setData(data.map((k) => ({ time: k.time as UTCTimestamp, open: k.open * scale, high: k.high * scale, low: k.low * scale, close: k.close * scale })));
    vs.setData(data.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? "rgba(229,169,103,0.32)" : "rgba(181,80,58,0.42)" })));
    chart.current?.applyOptions({ timeScale: { secondsVisible: iv === "1s" } });
    chart.current?.timeScale().fitContent();
  }, [data, scale, unit, iv]);

  // Live trades move the last candle.
  const last = data[data.length - 1];
  useEffect(() => {
    if (!candleSeries.current || !last) return;
    const close = coin.priceUsd;
    last.close = close;
    last.high = Math.max(last.high, close);
    last.low = Math.min(last.low, close);
    candleSeries.current.update({ time: last.time as UTCTimestamp, open: last.open * scale, high: last.high * scale, low: last.low * scale, close: close * scale });
  }, [coin.priceUsd, last, scale]);

  const shown: Ohlc | undefined = hover ?? last;
  const change = shown && data[0] ? shown.close / data[0].open - 1 : 0;
  const fmt = (v: number) => (unit === "MCap" ? usdCompact(v * SUPPLY) : price(v));
  return (
    <div className="panel overflow-hidden">
      {/* Below md the intervals fill their own row (44px each, as every .tab is there) and the units share the next with the pair; under 360px the row gets the side padding it needs for six of them. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 max-[359px]:px-2">
        <Segmented size={isMobile ? "sm" : "xs"} label="Interval" options={Object.keys(INTERVALS) as Interval[]} value={iv} onChange={setIv} className="max-md:grid max-md:w-full max-md:grid-cols-6" />
        <Segmented size={isMobile ? "sm" : "xs"} label="Units" options={["Price", "MCap"] as const} value={unit} onChange={setUnit} className="max-md:grid max-md:grid-cols-2" />
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted max-md:min-w-0">
          <CandlestickChart className="h-3.5 w-3.5 text-copper max-md:shrink-0" />
          <span className="max-md:truncate">
            {coin.ticker}/SOL · {coin.migrated ? "Raydium CPMM" : "Bonding curve"}
          </span>
        </span>
      </div>
      {/*
        On a phone in landscape (under 480px tall) the chart fits between the header and the docked Buy / Sell bar: the
        screen less 12rem (the 3.5rem header, the 3rem bar, the 5rem below it where the nav sits, and 0.5rem to spare).
        It's sized from the small viewport (svh), so it holds still while the browser's bars come and go. No floor: one
        taller than that space would put the chart's foot under the bar on the shortest screens.
      */}
      <div className="relative h-[420px] max-md:h-[300px] max-md:[@media(max-height:480px)_and_(orientation:landscape)]:h-[calc(100svh-12rem)]">
        {shown && (
          <div className="pointer-events-none absolute left-3 top-2 z-10 flex flex-wrap items-baseline gap-x-3 text-[11.5px]">
            <span className="text-base font-semibold text-cream">{fmt(shown.close)}</span>
            <span className={cx("num font-semibold", change >= 0 ? "text-gold" : "text-ember")}>{pct(change)}</span>
            {/* On a phone the full OHLC row shows only while a finger is on the chart, so the readout stays one line. */}
            {(!isMobile || hover) &&
              (["open", "high", "low", "close"] as const).map((k) => (
                <span key={k} className="num text-muted">
                  {k[0].toUpperCase()} <span className="text-cream">{fmt(shown[k])}</span>
                </span>
              ))}
            {!hover && (
              <span className="num text-muted">
                Vol 24h <span className="text-cream">${compact(coin.vol24hUsd)}</span>
              </span>
            )}
          </div>
        )}
        <div ref={box} className="absolute inset-0" data-bars={data.length} />
      </div>
    </div>
  );
}
