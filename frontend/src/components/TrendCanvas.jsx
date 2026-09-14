import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { getPhaseSlug } from '../utils/phase';

const REACTOR_TAG_CONFIG = {
    R1: {
        TEMP: { d: 'Temperature', u: '°C', min: -20, max: 150, col: '#b4451f', digits: 1 },
        JKT_TEMP: { d: 'Jacket temp', u: '°C', min: -25, max: 160, col: '#c9822f', digits: 1 },
        PRES: { d: 'Pressure', u: 'bar', min: -1, max: 6, col: '#1f6e7a', digits: 2 },
        AGIT: { d: 'Agitator', u: 'rpm', min: 0, max: 200, col: '#5d4e8c', digits: 0 },
        VOL: { d: 'Volume', u: 'L', min: 0, max: 5000, col: '#2e5c8a', digits: 0 }
    },
    R2: {
        PH: { d: 'Product pH', u: 'pH', min: 0, max: 14, col: '#7a2e8c', digits: 2 },
        TEMP: { d: 'Temperature', u: '°C', min: -10, max: 120, col: '#b4451f', digits: 1 },
        DOSE_FLOW: { d: 'Dosing flow', u: 'L/h', min: 0, max: 500, col: '#0d9488', digits: 1 },
        DOSE_TOTAL: { d: 'Dosed total', u: 'L', min: 0, max: 2000, col: '#d97706', digits: 1 },
        VOL: { d: 'Volume', u: 'L', min: 0, max: 5000, col: '#2e5c8a', digits: 0 }
    },
    R3: {
        TEMP: { d: 'Temperature', u: '°C', min: -20, max: 120, col: '#b4451f', digits: 1 },
        COOL_RATE: { d: 'Cooling rate', u: '°C/h', min: -30, max: 30, col: '#0284c7', digits: 1 },
        TURB: { d: 'Turbidity', u: 'NTU', min: 0, max: 1000, col: '#16a34a', digits: 0 },
        AGIT: { d: 'Agitator', u: 'rpm', min: 0, max: 150, col: '#5d4e8c', digits: 0 },
        VOL: { d: 'Volume', u: 'L', min: 0, max: 3000, col: '#2e5c8a', digits: 0 }
    }
};

const REACTOR_TAGS = {
    R1: ['TEMP', 'JKT_TEMP', 'PRES', 'AGIT', 'VOL'],
    R2: ['PH', 'TEMP', 'DOSE_FLOW', 'DOSE_TOTAL', 'VOL'],
    R3: ['TEMP', 'COOL_RATE', 'TURB', 'AGIT', 'VOL']
};

// Grafana-style vertical stacked lanes for multi-level visualization
const REACTOR_LANES = {
    R1: [
        { id: 'thermal', title: 'Thermal (°C)', tags: ['TEMP', 'JKT_TEMP'] },
        { id: 'press', title: 'Pressure', tags: ['PRES'] },
        { id: 'agitation', title: 'Agitation', tags: ['AGIT'] },
        { id: 'vol', title: 'Volume (L)', tags: ['VOL'] }
    ],
    R2: [
        { id: 'ph', title: 'pH', tags: ['PH'] },
        { id: 'thermal', title: 'Thermal (°C)', tags: ['TEMP'] },
        { id: 'dosing', title: 'Reagent Dosing', tags: ['DOSE_FLOW', 'DOSE_TOTAL'] },
        { id: 'vol', title: 'Volume (L)', tags: ['VOL'] }
    ],
    R3: [
        { id: 'cooling', title: 'Thermal & Cooling Rate', tags: ['TEMP', 'COOL_RATE'] },
        { id: 'crystal', title: 'Turbidity', tags: ['TURB'] },
        { id: 'agitation', title: 'Agitation', tags: ['AGIT'] },
        { id: 'vol', title: 'Volume (L)', tags: ['VOL'] }
    ]
};

const TIME_RANGES = [
    { label: '5m', hours: 5 / 60, tickIntervalMin: 1 },
    { label: '15m', hours: 15 / 60, tickIntervalMin: 3 },
    { label: '30m', hours: 30 / 60, tickIntervalMin: 5 },
    { label: '1h', hours: 1, tickIntervalMin: 10 },
    { label: '3h', hours: 3, tickIntervalMin: 30 },
    { label: '6h', hours: 6, tickIntervalMin: 60 },
    { label: '12h', hours: 12, tickIntervalMin: 120 }
];

function formatTime(d) {
    if (!d) return '';
    const date = new Date(d);
    return date.toTimeString().slice(0, 8);
}

function formatTimeShort(d, rangeHours) {
    if (!d) return '';
    const date = new Date(d);
    if (rangeHours <= 15 / 60) {
        return date.toTimeString().slice(0, 8); // HH:mm:ss for tight zoom
    }
    return date.toTimeString().slice(0, 5); // HH:mm
}

export default function TrendCanvas({ selectedReactor, onSelectReactor, clock }) {
    const containerRef = useRef(null);
    const canvasRef = useRef(null);
    const [readings, setReadings] = useState([]);
    const [events, setEvents] = useState([]);
    const [viewMode, setViewMode] = useState('stacked'); // 'stacked' (Grafana multi-level) or 'overlay'
    const [timeRange, setTimeRange] = useState(3); // Default 3 hours
    const [hiddenTags, setHiddenTags] = useState(new Set());
    const [hover, setHover] = useState(null); // { mouseX, mouseY, time, nearestPoints, activePhase }

    // Reset hidden tags whenever user switches reactor
    useEffect(() => {
        setHiddenTags(new Set());
    }, [selectedReactor]);

    const TAG_CONFIG = REACTOR_TAG_CONFIG[selectedReactor] || REACTOR_TAG_CONFIG.R1;
    const activeParams = REACTOR_TAGS[selectedReactor] || REACTOR_TAGS.R1;
    const lanes = REACTOR_LANES[selectedReactor] || REACTOR_LANES.R1;

    // Responsive canvas height based on view mode
    const canvasHeight = viewMode === 'stacked' ? 420 : 360;
    const [canvasWidth, setCanvasWidth] = useState(700);

    // Toggle visibility of specific tag curve
    const toggleTag = (param) => {
        setHiddenTags(prev => {
            const next = new Set(prev);
            if (next.has(param)) next.delete(param);
            else next.add(param);
            return next;
        });
    };

    // Watch container resize for responsive canvas width
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const ro = new ResizeObserver((entries) => {
            for (let entry of entries) {
                if (entry.contentRect.width > 0) {
                    setCanvasWidth(Math.floor(entry.contentRect.width));
                }
            }
        });
        ro.observe(container);
        return () => ro.disconnect();
    }, []);

    // Fetch time-series readings and phase events
    useEffect(() => {
        let isSubscribed = true;

        const fetchData = () => {
            const nowTime = clock ? new Date(clock) : new Date();
            const from = new Date(nowTime.getTime() - timeRange * 3600 * 1000);
            const tagList = activeParams.map(t => `${selectedReactor}.${t}`).join(',');

            Promise.all([
                fetch(`/ui/readings?tags=${tagList}&from=${from.toISOString()}&to=${nowTime.toISOString()}&resolution=raw`).then(r => r.json()),
                fetch(`/ui/events?asset=${selectedReactor}&level=Phase&from=${from.toISOString()}&to=${nowTime.toISOString()}&limit=150`).then(r => r.json())
            ]).then(([readingsRes, eventsRes]) => {
                if (!isSubscribed) return;
                setReadings(readingsRes.data || []);
                setEvents(eventsRes || []);
            }).catch(console.error);
        };

        fetchData();
        const timer = setInterval(fetchData, 10000);

        return () => {
            isSubscribed = false;
            clearInterval(timer);
        };
    }, [selectedReactor, timeRange, clock, activeParams]);

    // Compute latest readings map for live legend display
    const latestValues = useMemo(() => {
        const map = {};
        activeParams.forEach(param => {
            const fullTagName = `${selectedReactor}.${param}`;
            const series = readings.filter(r => r.tag === fullTagName && r.value !== null);
            if (series.length > 0) {
                map[param] = series[series.length - 1].value;
            } else {
                map[param] = null;
            }
        });
        return map;
    }, [readings, activeParams, selectedReactor]);

    // Canvas boundary calculations
    const bounds = useMemo(() => {
        const t1 = clock ? new Date(clock).getTime() : Date.now();
        const t0 = t1 - timeRange * 3600 * 1000;
        const span = Math.max(1000, t1 - t0);
        const L = 46;
        const Rp = 20; // Y-axis is kept on left only in both stacked and overlay modes
        const x0 = L;
        const cw = Math.max(10, canvasWidth - L - Rp);
        const y0 = 24; // Space for phase header chips
        const ch = canvasHeight - 52; // Total graph area height
        return { t0, t1, span, L, Rp, x0, cw, y0, ch };
    }, [clock, timeRange, canvasWidth, canvasHeight]);

    // Unit analysis for Overlay mode (determines if Y-axis can be displayed)
    const overlayUnitInfo = useMemo(() => {
        const visibleParams = activeParams.filter(param => !hiddenTags.has(param));
        const uniqueUnits = Array.from(new Set(visibleParams.map(p => TAG_CONFIG[p]?.u).filter(Boolean)));
        const hasSameUnits = visibleParams.length > 0 && uniqueUnits.length === 1;

        if (!hasSameUnits) {
            return { hasSameUnits: false, unit: '', min: 0, max: 100, digits: 1, visibleParams };
        }

        return {
            hasSameUnits: true,
            unit: uniqueUnits[0],
            min: Math.min(...visibleParams.map(p => TAG_CONFIG[p].min)),
            max: Math.max(...visibleParams.map(p => TAG_CONFIG[p].max)),
            digits: Math.max(...visibleParams.map(p => TAG_CONFIG[p].digits || 0)),
            visibleParams
        };
    }, [activeParams, hiddenTags, TAG_CONFIG]);

    // Precalculate lane positions for stacked mode:
    // If tags are selected out, that chart is cut off and remaining charts autonomously scale their height & Y-scale
    const laneLayout = useMemo(() => {
        const { y0, ch } = bounds;

        // Cut off any lane where all tags have been selected out (hidden)
        const visibleLanes = lanes
            .map(lane => ({
                ...lane,
                visibleTags: lane.tags.filter(t => !hiddenTags.has(t))
            }))
            .filter(lane => lane.visibleTags.length > 0);

        const n = visibleLanes.length;
        if (n === 0) return [];

        // Autonomous height scaling for remaining active charts
        const gap = n > 1 ? 10 : 0;
        const h = Math.max(30, (ch - (n - 1) * gap) / n);

        return visibleLanes.map((lane, i) => {
            const configs = lane.visibleTags.map(t => TAG_CONFIG[t]).filter(Boolean);
            const units = Array.from(new Set(configs.map(c => c.u).filter(Boolean)));
            const sameUnit = units.length === 1;
            const laneMin = Math.min(...configs.map(c => c.min));
            const laneMax = Math.max(...configs.map(c => c.max));
            const laneDigits = Math.max(...configs.map(c => c.digits || 0));
            const laneUnit = sameUnit ? units[0] : (configs[0]?.u || '');

            return {
                ...lane,
                index: i,
                yTop: y0 + i * (h + gap),
                height: h,
                sameUnit,
                unit: laneUnit,
                min: laneMin,
                max: laneMax,
                digits: laneDigits,
                configs
            };
        });
    }, [bounds, lanes, hiddenTags, TAG_CONFIG]);

    // Handle mouse hover for crosshair and tooltip
    const handleMouseMove = useCallback((e) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const { t0, span, x0, cw, y0, ch } = bounds;

        if (mouseX < x0 || mouseX > x0 + cw || mouseY < y0 - 16 || mouseY > y0 + ch + 26) {
            setHover(null);
            return;
        }

        const frac = Math.max(0, Math.min(1, (mouseX - x0) / cw));
        const hoverTime = t0 + frac * span;

        // Find active phase event at hoverTime
        const activePhase = events.find(ev => {
            const start = new Date(ev.started_at).getTime();
            const end = ev.ended_at ? new Date(ev.ended_at).getTime() : Infinity;
            return hoverTime >= start && hoverTime <= end;
        });

        // Find nearest reading for each active tag
        const nearestPoints = {};
        activeParams.forEach(param => {
            if (hiddenTags.has(param)) return;
            const fullTagName = `${selectedReactor}.${param}`;
            const series = readings.filter(r => r.tag === fullTagName && r.value !== null);
            if (series.length === 0) return;

            let closest = series[0];
            let minDiff = Math.abs(new Date(closest.time).getTime() - hoverTime);
            for (let i = 1; i < series.length; i++) {
                const diff = Math.abs(new Date(series[i].time).getTime() - hoverTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = series[i];
                }
            }

            // Snap if within reasonable window of data
            const maxDelta = Math.max(30000, (span / cw) * 15);
            if (minDiff <= maxDelta) {
                nearestPoints[param] = closest;
            }
        });

        setHover({
            mouseX,
            mouseY,
            time: hoverTime,
            nearestPoints,
            activePhase
        });
    }, [bounds, events, activeParams, hiddenTags, selectedReactor, readings]);

    const handleMouseLeave = useCallback(() => {
        setHover(null);
    }, []);

    // Main Canvas Paint Loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const w = canvasWidth;
        const h = canvasHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.height = `${h}px`;

        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);

        const { t0, t1, span, x0, cw, y0, ch } = bounds;
        const activeRange = TIME_RANGES.find(r => Math.abs(r.hours - timeRange) < 0.001) || TIME_RANGES[4];

        // -------------------------------------------------------------
        // 1. Draw Phase Bands Across the Entire Canvas Background
        // -------------------------------------------------------------
        events.forEach(ev => {
            const a = Math.max(new Date(ev.started_at).getTime(), t0);
            const b = ev.ended_at ? Math.min(new Date(ev.ended_at).getTime(), t1) : t1;
            if (b < t0 || a > t1) return;

            const bx = x0 + ((a - t0) / span) * cw;
            const bw = ((b - a) / span) * cw;

            const isHovered = hover?.activePhase?.id === ev.id;
            const phaseSlug = getPhaseSlug(ev.name);
            const phaseColor = getComputedStyle(document.documentElement).getPropertyValue(`--${phaseSlug}`).trim() || '#7d868c';

            // Background Tint
            g.fillStyle = phaseColor;
            g.globalAlpha = isHovered ? 0.22 : 0.12;
            g.fillRect(bx, y0, bw, ch);
            g.globalAlpha = 1;

            // Phase Boundary Vertical Line
            g.strokeStyle = isHovered ? '#3b4349' : 'rgba(125, 134, 140, 0.4)';
            g.lineWidth = isHovered ? 1.5 : 1;
            g.beginPath();
            g.moveTo(bx + 0.5, y0 - 18);
            g.lineTo(bx + 0.5, y0 + ch);
            g.stroke();

            // Top Phase Header Chip
            if (bw > 30) {
                const chipH = 16;
                const chipY = y0 - chipH - 3;
                const chipW = Math.min(bw - 4, 110);

                g.fillStyle = phaseColor;
                g.globalAlpha = isHovered ? 0.95 : 0.85;
                g.beginPath();
                g.roundRect(bx + 2, chipY, chipW, chipH, 3);
                g.fill();
                g.globalAlpha = 1;

                g.fillStyle = '#ffffff';
                g.font = '600 9.5px "IBM Plex Sans", sans-serif';
                g.textAlign = 'left';
                const text = ev.name.length > 14 && chipW < 90 ? ev.name.slice(0, 12) + '…' : ev.name;
                g.fillText(text, bx + 6, chipY + 11.5);
            }
        });

        // -------------------------------------------------------------
        // 2. Render Lanes (Stacked Grafana-style or Single Overlay)
        // -------------------------------------------------------------
        if (viewMode === 'stacked') {
            // Stacked Multi-Level Mode
            if (laneLayout.length === 0) {
                g.fillStyle = '#6d777d';
                g.font = '12px "IBM Plex Sans", sans-serif';
                g.textAlign = 'center';
                g.fillText('All charts cut off · Select tags from legend below to display', x0 + cw / 2, y0 + ch / 2);
            }

            laneLayout.forEach(lane => {
                const ly0 = lane.yTop;
                const lh = lane.height;

                // Dark solid divider line separating stacked lanes
                if (lane.index < laneLayout.length - 1) {
                    const sepY = Math.round(ly0 + lh + 5) + 0.5;
                    // Clear background tint in the separator gap for high contrast
                    g.clearRect(x0, ly0 + lh + 1, cw, 8);
                }

                // Lane title badge in upper-right
                g.font = '600 9.5px "IBM Plex Sans", sans-serif';
                g.textAlign = 'right';
                const titleW = g.measureText(lane.title).width + 8;
                g.fillStyle = 'rgba(255, 255, 255, 0.85)';
                g.fillRect(x0 + cw - titleW - 4, ly0 + 2, titleW, 13);
                g.fillStyle = '#1b2124';
                g.fillText(lane.title, x0 + cw - 8, ly0 + 12);

                // Lane horizontal grid lines & Y-axis labels (LEFT ONLY)
                g.font = '9.5px "IBM Plex Sans", sans-serif';
                for (let i = 0; i <= 2; i++) {
                    const y = ly0 + lh - (i / 2) * lh;

                    // Grid line (baseline i === 0 is dark solid, upper grid lines are dashed)
                    g.strokeStyle = i === 0 ? '#1b2124' : 'rgba(120, 130, 136, 0.22)';
                    g.lineWidth = i === 0 ? 1.5 : 1;
                    g.setLineDash(i === 0 ? [] : [2, 3]);
                    g.beginPath();
                    g.moveTo(x0, y);
                    g.lineTo(x0 + cw, y);
                    g.stroke();
                    g.setLineDash([]);
                    g.lineWidth = 1;

                    // Left Y-axis ONLY: autonomous scale and unit
                    g.fillStyle = lane.visibleTags.length === 1 ? lane.configs[0].col : '#1b2124';
                    g.textAlign = 'right';
                    const v = (lane.min + ((lane.max - lane.min) * i) / 2).toFixed(lane.digits);
                    const label = i === 2 ? `${v} ${lane.unit}` : v;
                    g.fillText(label, x0 - 6, y + 3.5);
                }

                // Draw curves belonging to this lane's active tags
                lane.visibleTags.forEach(param => {
                    const fullTagName = `${selectedReactor}.${param}`;
                    const conf = TAG_CONFIG[param];
                    const series = readings.filter(r => r.tag === fullTagName);

                    g.strokeStyle = conf.col;
                    g.lineWidth = 1.8;
                    g.beginPath();
                    let started = false;

                    series.forEach(pt => {
                        const ptTime = new Date(pt.time).getTime();
                        if (ptTime < t0) return;

                        if (pt.value === null) {
                            started = false;
                            return;
                        }

                        const x = x0 + ((ptTime - t0) / span) * cw;
                        const range = Math.max(0.0001, lane.max - lane.min);
                        const norm = Math.max(0, Math.min(1, (pt.value - lane.min) / range));
                        const y = ly0 + lh - norm * lh;

                        if (!started) {
                            g.moveTo(x, y);
                            started = true;
                        } else {
                            g.lineTo(x, y);
                        }
                    });
                    g.stroke();
                });
            });

        } else {
            // Unified Overlay Mode
            g.strokeStyle = '#8d959b';
            g.lineWidth = 1;
            g.strokeRect(x0 + 0.5, y0 + 0.5, cw, ch);

            const { hasSameUnits, unit: sharedUnit, min: sharedMin, max: sharedMax, digits: sharedDigits, visibleParams } = overlayUnitInfo;

            g.font = '9.5px "IBM Plex Sans", sans-serif';
            for (let i = 0; i <= 4; i++) {
                const y = y0 + ch - (i / 4) * ch;

                g.strokeStyle = i === 0 ? '#7d868c' : 'rgba(120, 130, 136, 0.22)';
                g.lineWidth = 1;
                g.setLineDash(i === 0 ? [] : [3, 4]);
                g.beginPath();
                g.moveTo(x0, y);
                g.lineTo(x0 + cw, y);
                g.stroke();
                g.setLineDash([]);

                // In Overlay mode:
                // - If all tags or tags with different units are selected: do NOT show Y-axis on either side.
                // - If visible tags share the EXACT SAME unit: show only on the left vertical axis.
                if (hasSameUnits) {
                    g.fillStyle = visibleParams.length === 1 ? TAG_CONFIG[visibleParams[0]].col : '#4e585e';
                    g.textAlign = 'right';
                    const v = (sharedMin + ((sharedMax - sharedMin) * i) / 4).toFixed(sharedDigits);
                    const label = i === 4 ? `${v} ${sharedUnit}` : v;
                    g.fillText(label, x0 - 6, y + 3.5);
                }
            }

            activeParams.forEach(param => {
                if (hiddenTags.has(param)) return;

                const fullTagName = `${selectedReactor}.${param}`;
                const conf = TAG_CONFIG[param];
                const series = readings.filter(r => r.tag === fullTagName);

                g.strokeStyle = conf.col;
                g.lineWidth = 1.8;
                g.beginPath();
                let started = false;

                series.forEach(pt => {
                    const ptTime = new Date(pt.time).getTime();
                    if (ptTime < t0) return;

                    if (pt.value === null) {
                        started = false;
                        return;
                    }

                    const x = x0 + ((ptTime - t0) / span) * cw;
                    let norm = 0;
                    if (hasSameUnits) {
                        const range = Math.max(0.0001, sharedMax - sharedMin);
                        norm = Math.max(0, Math.min(1, (pt.value - sharedMin) / range));
                    } else {
                        const range = Math.max(0.0001, conf.max - conf.min);
                        norm = Math.max(0, Math.min(1, (pt.value - conf.min) / range));
                    }
                    const y = y0 + ch - norm * ch;

                    if (!started) {
                        g.moveTo(x, y);
                        started = true;
                    } else {
                        g.lineTo(x, y);
                    }
                });
                g.stroke();
            });
        }

        // -------------------------------------------------------------
        // 3. Time Axis (X-Axis): Ticks, Labels, and Shared Vertical Grid
        // -------------------------------------------------------------
        const tickMs = activeRange.tickIntervalMin * 60 * 1000;
        const firstTick = Math.ceil(t0 / tickMs) * tickMs;

        g.font = '10px "IBM Plex Sans", sans-serif';
        g.textAlign = 'center';

        for (let t = firstTick; t <= t1; t += tickMs) {
            const x = x0 + ((t - t0) / span) * cw;
            if (x < x0 + 8 || x > x0 + cw - 12) continue;

            // Vertical Grid Line cutting across all lanes
            g.strokeStyle = 'rgba(120, 130, 136, 0.16)';
            g.setLineDash([2, 3]);
            g.beginPath();
            g.moveTo(x, y0);
            g.lineTo(x, y0 + ch);
            g.stroke();
            g.setLineDash([]);

            // Axis Tick Mark
            g.strokeStyle = '#7d868c';
            g.beginPath();
            g.moveTo(x, y0 + ch);
            g.lineTo(x, y0 + ch + 4);
            g.stroke();

            // Formatted Time Label
            g.fillStyle = '#4e585e';
            g.fillText(formatTimeShort(t, timeRange), x, y0 + ch + 16);
        }

        // Right "LIVE" Edge Marker
        const liveX = x0 + cw;
        g.strokeStyle = '#2d7a3e';
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(liveX, y0);
        g.lineTo(liveX, y0 + ch + 6);
        g.stroke();

        g.fillStyle = '#2d7a3e';
        g.beginPath();
        g.arc(liveX, y0 + ch + 6, 2.5, 0, 2 * Math.PI);
        g.fill();

        g.font = '600 9px "IBM Plex Sans", sans-serif';
        g.textAlign = 'right';
        g.fillText('LIVE', liveX - 3, y0 + ch + 16);

        // -------------------------------------------------------------
        // 4. Interactive Crosshair & Snapping Dots
        // -------------------------------------------------------------
        if (hover && hover.mouseX >= x0 && hover.mouseX <= x0 + cw) {
            const hx = hover.mouseX;

            // Vertical Crosshair Line
            g.strokeStyle = '#21292e';
            g.lineWidth = 1.2;
            g.setLineDash([3, 3]);
            g.beginPath();
            g.moveTo(hx, y0);
            g.lineTo(hx, y0 + ch);
            g.stroke();
            g.setLineDash([]);

            // Bottom Crosshair Time Badge
            const timeStr = formatTime(hover.time);
            g.font = '600 9.5px "IBM Plex Sans", sans-serif';
            const badgeW = g.measureText(timeStr).width + 8;
            const badgeX = Math.max(x0, Math.min(x0 + cw - badgeW, hx - badgeW / 2));

            g.fillStyle = '#1e2529';
            g.beginPath();
            g.roundRect(badgeX, y0 + ch + 2, badgeW, 14, 2);
            g.fill();

            g.fillStyle = '#ffffff';
            g.textAlign = 'center';
            g.fillText(timeStr, badgeX + badgeW / 2, y0 + ch + 12);

            // Curve Snap Dots
            Object.entries(hover.nearestPoints).forEach(([param, pt]) => {
                const conf = TAG_CONFIG[param];
                if (!conf) return;

                let ny = 0;
                if (viewMode === 'stacked') {
                    const lane = laneLayout.find(l => l.visibleTags.includes(param));
                    if (!lane) return;
                    const range = Math.max(0.0001, lane.max - lane.min);
                    const norm = Math.max(0, Math.min(1, (pt.value - lane.min) / range));
                    ny = lane.yTop + lane.height - norm * lane.height;
                } else {
                    if (overlayUnitInfo.hasSameUnits) {
                        const range = Math.max(0.0001, overlayUnitInfo.max - overlayUnitInfo.min);
                        const norm = Math.max(0, Math.min(1, (pt.value - overlayUnitInfo.min) / range));
                        ny = y0 + ch - norm * ch;
                    } else {
                        const range = Math.max(0.0001, conf.max - conf.min);
                        const norm = Math.max(0, Math.min(1, (pt.value - conf.min) / range));
                        ny = y0 + ch - norm * ch;
                    }
                }

                // Outer Halo
                g.fillStyle = conf.col;
                g.beginPath();
                g.arc(hx, ny, 4.5, 0, 2 * Math.PI);
                g.fill();

                // Inner Dot
                g.fillStyle = '#ffffff';
                g.beginPath();
                g.arc(hx, ny, 2, 0, 2 * Math.PI);
                g.fill();
            });
        }

    }, [readings, events, clock, selectedReactor, canvasWidth, canvasHeight, timeRange, hiddenTags, bounds, hover, activeParams, viewMode, laneLayout, overlayUnitInfo, TAG_CONFIG]);

    return (
        <div className="panel trend" ref={containerRef}>
            {/* Header: Title, View Mode Picker, Time Range Selector, Reactor Picker */}
            <div className="thead">
                <div className="trend-title-group">
                    <h3>{selectedReactor} Trend Analysis</h3>
                    <span className="trend-subtitle">Time-series telemetry & ISA-88 phase overlays</span>
                </div>

                {/* View Mode Toggle: Stacked (Grafana multi-level) vs Overlay */}
                <div className="view-mode-toggle" role="group" aria-label="Chart layout">
                    <button
                        type="button"
                        className={viewMode === 'stacked' ? 'active' : ''}
                        onClick={() => setViewMode('stacked')}
                        title="Stacked Multi-Level Lanes (Grafana style)">
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 4 }}>
                            <rect x="1" y="2" width="14" height="3" rx="1" />
                            <rect x="1" y="7" width="14" height="3" rx="1" />
                            <rect x="1" y="12" width="14" height="3" rx="1" />
                        </svg>
                        Stacked
                    </button>
                    <button
                        type="button"
                        className={viewMode === 'overlay' ? 'active' : ''}
                        onClick={() => setViewMode('overlay')}
                        title="Unified Single-Canvas Overlay">
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 4 }}>
                            <rect x="1" y="2" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                            <path d="M3 11 L7 6 L10 9 L13 4" fill="none" stroke="currentColor" strokeWidth="1.8" />
                        </svg>
                        Overlay
                    </button>
                </div>

                {/* Time Range Selector: 5m, 15m, 30m, 1h, 3h, 6h, 12h */}
                <div className="range-picker" role="group" aria-label="Time range selection">
                    {TIME_RANGES.map(r => (
                        <button
                            key={r.label}
                            type="button"
                            className={Math.abs(timeRange - r.hours) < 0.001 ? 'active' : ''}
                            onClick={() => setTimeRange(r.hours)}
                            title={`View last ${r.label}`}>
                            {r.label}
                        </button>
                    ))}
                </div>

                {/* Reactor Switcher */}
                <div className="tsel" role="group" aria-label="Reactor selection">
                    {['R1', 'R2', 'R3'].map(r => (
                        <button
                            key={r}
                            type="button"
                            aria-pressed={selectedReactor === r}
                            onClick={() => onSelectReactor(r)}>
                            {r}
                        </button>
                    ))}
                </div>
            </div>

            {/* Canvas Container with Interactive Tooltip */}
            <div
                className="trend-canvas-wrap"
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}>
                <canvas ref={canvasRef} />

                {/* Floating Inspection Tooltip */}
                {hover && (
                    <div
                        className="trend-tooltip"
                        style={{
                            left: Math.min(canvasWidth - 210, Math.max(12, hover.mouseX + 16)),
                            top: Math.min(canvasHeight - 190, Math.max(10, hover.mouseY - 40))
                        }}>
                        <div className="tt-header">
                            <span className="tt-time">{formatTime(hover.time)}</span>
                            {hover.activePhase && (
                                <span
                                    className="tt-phase"
                                    style={{
                                        background: getComputedStyle(document.documentElement).getPropertyValue(`--${getPhaseSlug(hover.activePhase.name)}`).trim() || '#6c757d'
                                    }}>
                                    {hover.activePhase.name}
                                </span>
                            )}
                        </div>

                        {hover.activePhase?.batch_id && (
                            <div className="tt-batch">Batch: <b>{hover.activePhase.batch_id}</b></div>
                        )}

                        <div className="tt-readings">
                            {activeParams.map(param => {
                                if (hiddenTags.has(param)) return null;
                                const conf = TAG_CONFIG[param];
                                const pt = hover.nearestPoints[param];
                                const valStr = pt?.value !== null && pt?.value !== undefined
                                    ? Number(pt.value).toFixed(conf.digits)
                                    : '—';

                                return (
                                    <div key={param} className="tt-row">
                                        <span className="tt-tag-name">
                                            <i style={{ background: conf.col }} />
                                            {conf.d}:
                                        </span>
                                        <span className="tt-tag-val">
                                            <b>{valStr}</b> {conf.u}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Scale Note */}
            <div className="axnote">
                <span className="axnote-hint">
                    {viewMode === 'overlay' && !overlayUnitInfo.hasSameUnits
                        ? 'Overlay mode: Normalized relative scale (Y-axes hidden for mixed units) · Hover to inspect values'
                        : viewMode === 'overlay' && overlayUnitInfo.hasSameUnits
                            ? `Overlay mode: Left vertical axis in ${overlayUnitInfo.unit} · Hover to inspect values`
                            : 'Stacked mode: Left vertical axis per active chart · Deselected tags cut off chart & auto-scale layout'}
                </span>
            </div>

            {/* Interactive Legend with Latest Value Readout & Toggleability */}
            <div className="legend-toolbar">
                {activeParams.map(p => {
                    const conf = TAG_CONFIG[p];
                    const isHidden = hiddenTags.has(p);
                    const liveVal = latestValues[p] !== null && latestValues[p] !== undefined
                        ? Number(latestValues[p]).toFixed(conf.digits)
                        : '—';

                    return (
                        <button
                            key={p}
                            type="button"
                            className={`legend-pill ${isHidden ? 'hidden-trace' : ''}`}
                            onClick={() => toggleTag(p)}
                            title={isHidden ? `Show ${conf.d}` : `Hide ${conf.d}`}>
                            <span className="pill-dot" style={{ background: isHidden ? '#9da5aa' : conf.col }} />
                            <span className="pill-label">{conf.d}:</span>
                            <span className="pill-val">{liveVal} {conf.u}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}