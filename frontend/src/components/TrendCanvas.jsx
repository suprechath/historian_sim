import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { getPhaseSlug } from '../utils/phase';

const REACTOR_TAG_CONFIG = {
    R1: {
        TEMP: { d: 'Temperature', u: '°C', min: -20, max: 150, col: '#b4451f', digits: 1 },
        JKT_TEMP: { d: 'Jacket temp', u: '°C', min: -25, max: 160, col: '#c9822f', digits: 1 },
        PRES: { d: 'Pressure', u: 'bar', min: -1, max: 6, col: '#1f6e7a', digits: 2 },
        FILTER_DP: { d: 'Filter ΔP', u: 'bar', min: 0, max: 2.5, col: '#d97706', digits: 2 },
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
    R1: ['TEMP', 'JKT_TEMP', 'PRES', 'FILTER_DP', 'AGIT', 'VOL'],
    R2: ['PH', 'TEMP', 'DOSE_FLOW', 'DOSE_TOTAL', 'VOL'],
    R3: ['TEMP', 'COOL_RATE', 'TURB', 'AGIT', 'VOL']
};

// Grafana-style vertical stacked lanes for multi-level visualization
const REACTOR_LANES = {
    R1: [
        { id: 'thermal', title: 'Thermal (°C)', tags: ['TEMP', 'JKT_TEMP'] },
        { id: 'press', title: 'Pressure & Filter ΔP', tags: ['PRES', 'FILTER_DP'] },
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
    { label: '12h', hours: 12, tickIntervalMin: 120 },
    { label: '24h', hours: 24, tickIntervalMin: 240 },
    { label: '3d', hours: 72, tickIntervalMin: 720 }
];

function formatTime(d) {
    if (!d) return '';
    const date = new Date(d);
    return date.toTimeString().slice(0, 8);
}

function formatFullDateTime(d) {
    if (!d) return '';
    const date = new Date(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(ms) {
    const sec = Math.round(Math.abs(ms) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
    const hrs = Math.floor(min / 60);
    const remMin = min % 60;
    if (hrs < 24) return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

function toDatetimeLocalString(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const h = pad(d.getHours());
    const min = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

function parseDatetimeLocal(str) {
    if (!str) return null;
    if (str instanceof Date) return isNaN(str.getTime()) ? null : str;
    const s = String(str).trim();
    if (!s) return null;

    const timeOnlyMatch = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (timeOnlyMatch) {
        const now = new Date();
        const d = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            parseInt(timeOnlyMatch[1], 10),
            parseInt(timeOnlyMatch[2], 10),
            parseInt(timeOnlyMatch[3] || '0', 10)
        );
        return isNaN(d.getTime()) ? null : d;
    }

    const normalized = s.replace(' ', 'T');
    const d = new Date(normalized);
    if (!isNaN(d.getTime())) return d;
    const dRaw = new Date(s);
    return isNaN(dRaw.getTime()) ? null : dRaw;
}

function getTickInterval(spanMs) {
    const sec = spanMs / 1000;
    if (sec <= 30) return 5 * 1000;          // 5s
    if (sec <= 90) return 15 * 1000;         // 15s
    if (sec <= 300) return 30 * 1000;        // 30s
    if (sec <= 600) return 60 * 1000;        // 1m
    if (sec <= 1800) return 2 * 60 * 1000;   // 2m
    if (sec <= 3600) return 5 * 60 * 1000;   // 5m
    if (sec <= 7200) return 10 * 60 * 1000;  // 10m
    if (sec <= 14400) return 20 * 60 * 1000; // 20m
    if (sec <= 28800) return 30 * 60 * 1000; // 30m
    if (sec <= 43200) return 60 * 60 * 1000; // 1h
    if (sec <= 86400) return 2 * 3600 * 1000;// 2h
    return 6 * 3600 * 1000;                  // 6h
}

function formatTimeShort(d, rangeHours) {
    if (!d) return '';
    const date = new Date(d);
    if (rangeHours <= 1) {
        return date.toTimeString().slice(0, 8); // HH:mm:ss for tight zoom
    }
    if (rangeHours <= 24) {
        return date.toTimeString().slice(0, 5); // HH:mm
    }
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${date.toTimeString().slice(0, 5)}`;
}

export default function TrendCanvas({ selectedReactor, onSelectReactor, clock }) {
    const containerRef = useRef(null);
    const canvasRef = useRef(null);
    const [readings, setReadings] = useState([]);
    const [events, setEvents] = useState([]);
    const [viewMode, setViewMode] = useState('stacked'); // 'stacked' (Grafana multi-level) or 'overlay'
    const [timeRange, setTimeRange] = useState(3); // Default 3 hours
    const [customRange, setCustomRange] = useState(null); // null or { from: Date, to: Date }
    const [isCustomRangeOpen, setIsCustomRangeOpen] = useState(false);
    const [rangeError, setRangeError] = useState(null);
    const [dragSelection, setDragSelection] = useState(null); // { startX, currentX, startTime, currentTime }
    const [time1Input, setTime1Input] = useState('');
    const [time2Input, setTime2Input] = useState('');
    const [hiddenTags, setHiddenTags] = useState(new Set());
    const [hover, setHover] = useState(null); // { mouseX, mouseY, time, nearestPoints, activePhase }
    const [isCollapsed, setIsCollapsed] = useState(() => {
        try {
            return localStorage.getItem('historian_trend_collapsed') === 'true';
        } catch {
            return false;
        }
    });

    const toggleCollapse = () => {
        setIsCollapsed(prev => {
            const next = !prev;
            try {
                localStorage.setItem('historian_trend_collapsed', String(next));
            } catch {
                // Ignore storage errors
            }
            return next;
        });
    };

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

    // Re-check width immediately upon expanding
    useEffect(() => {
        if (!isCollapsed && containerRef.current) {
            const w = containerRef.current.clientWidth;
            if (w > 0) {
                setCanvasWidth(Math.floor(w));
            }
        }
    }, [isCollapsed]);

    // Fetch time-series readings and phase events
    useEffect(() => {
        if (isCollapsed) return;
        let isSubscribed = true;

        const fetchData = () => {
            let fromDate, toDate;
            if (customRange) {
                fromDate = customRange.from;
                toDate = customRange.to;
            } else {
                const nowTime = clock ? new Date(clock) : new Date();
                fromDate = new Date(nowTime.getTime() - timeRange * 3600 * 1000);
                toDate = nowTime;
            }

            const spanHours = Math.max(0.001, (toDate.getTime() - fromDate.getTime()) / (3600 * 1000));
            const resParam = spanHours <= 4 ? 'raw' : 'auto';
            const tagList = activeParams.map(t => `${selectedReactor}.${t}`).join(',');

            Promise.all([
                fetch(`/ui/readings?tags=${tagList}&from=${fromDate.toISOString()}&to=${toDate.toISOString()}&resolution=${resParam}`).then(r => r.json()),
                fetch(`/ui/events?asset=${selectedReactor}&level=Phase&from=${fromDate.toISOString()}&to=${toDate.toISOString()}&limit=600`).then(r => r.json())
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
    }, [isCollapsed, selectedReactor, timeRange, customRange, customRange ? null : clock, activeParams]);

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
        let t0, t1;
        if (customRange) {
            t0 = customRange.from.getTime();
            t1 = customRange.to.getTime();
        } else {
            t1 = clock ? new Date(clock).getTime() : Date.now();
            t0 = t1 - timeRange * 3600 * 1000;
        }
        const span = Math.max(1000, t1 - t0);
        const L = 46;
        const Rp = 20; // Y-axis is kept on left only in both stacked and overlay modes
        const x0 = L;
        const cw = Math.max(10, canvasWidth - L - Rp);
        const y0 = 24; // Space for phase header chips
        const ch = canvasHeight - 52; // Total graph area height
        return { t0, t1, span, L, Rp, x0, cw, y0, ch };
    }, [clock, timeRange, customRange, canvasWidth, canvasHeight]);

    // Initialize input values once on initial mount
    useEffect(() => {
        const now = clock ? new Date(clock).getTime() : Date.now();
        const start = now - timeRange * 3600 * 1000;
        setTime1Input(toDatetimeLocalString(new Date(start)));
        setTime2Input(toDatetimeLocalString(new Date(now)));
    }, []);

    // Sync input values ONLY when customRange changes (e.g. drag selection, pan, zoom, or presets)
    // NEVER overwrite while user is editing in live mode!
    useEffect(() => {
        if (customRange) {
            setTime1Input(toDatetimeLocalString(customRange.from));
            setTime2Input(toDatetimeLocalString(customRange.to));
        }
    }, [customRange]);

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

    // Global listener for drag-to-select range across chart
    useEffect(() => {
        if (!dragSelection) return;

        const handleGlobalMouseMove = (e) => {
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const mouseX = e.clientX - rect.left;
            const { t0, span, x0, cw } = bounds;
            const clampedX = Math.max(x0, Math.min(x0 + cw, mouseX));
            const frac = Math.max(0, Math.min(1, (clampedX - x0) / cw));
            const time = t0 + frac * span;

            setDragSelection(prev => prev ? ({
                ...prev,
                currentX: clampedX,
                currentTime: time
            }) : null);
        };

        const handleGlobalMouseUp = () => {
            setDragSelection(prev => {
                if (prev) {
                    const dx = Math.abs(prev.currentX - prev.startX);
                    if (dx >= 12) {
                        const tMin = Math.min(prev.startTime, prev.currentTime);
                        const tMax = Math.max(prev.startTime, prev.currentTime);
                        if (tMax - tMin >= 2000) {
                            setCustomRange({
                                from: new Date(tMin),
                                to: new Date(tMax)
                            });
                        }
                    }
                }
                return null;
            });
        };

        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [dragSelection, bounds]);

    const handlePanLeft = () => {
        if (!customRange) return;
        const d = (customRange.to.getTime() - customRange.from.getTime()) * 0.5;
        setCustomRange({
            from: new Date(customRange.from.getTime() - d),
            to: new Date(customRange.to.getTime() - d)
        });
    };

    const handlePanRight = () => {
        if (!customRange) return;
        const d = (customRange.to.getTime() - customRange.from.getTime()) * 0.5;
        setCustomRange({
            from: new Date(customRange.from.getTime() + d),
            to: new Date(customRange.to.getTime() + d)
        });
    };

    const handleZoomIn = () => {
        if (!customRange) return;
        const mid = (customRange.from.getTime() + customRange.to.getTime()) / 2;
        const half = (customRange.to.getTime() - customRange.from.getTime()) / 4;
        setCustomRange({
            from: new Date(mid - half),
            to: new Date(mid + half)
        });
    };

    const handleZoomOut = () => {
        if (!customRange) return;
        const mid = (customRange.from.getTime() + customRange.to.getTime()) / 2;
        const half = customRange.to.getTime() - customRange.from.getTime();
        setCustomRange({
            from: new Date(mid - half),
            to: new Date(mid + half)
        });
    };

    const toggleCustomRangePanel = () => {
        setIsCustomRangeOpen(prev => {
            const next = !prev;
            if (next && !customRange) {
                // Initialize input fields with current visible chart bounds at the moment user opens panel
                const { t0, t1 } = bounds;
                setTime1Input(toDatetimeLocalString(new Date(t0)));
                setTime2Input(toDatetimeLocalString(new Date(t1)));
            }
            if (!next) {
                setRangeError(null);
            }
            return next;
        });
    };

    const handleResetToLive = () => {
        setCustomRange(null);
        setIsCustomRangeOpen(false);
        setRangeError(null);
    };

    const handleApplyCustomRange = (e) => {
        e?.preventDefault();
        setRangeError(null);
        const d1 = parseDatetimeLocal(time1Input);
        const d2 = parseDatetimeLocal(time2Input);
        if (!d1 || !d2) {
            setRangeError('Please select both Start Time (Time 1) and End Time (Time 2).');
            return;
        }
        if (d1.getTime() >= d2.getTime()) {
            setRangeError('Start Time (Time 1) must be strictly before End Time (Time 2).');
            return;
        }
        setRangeError(null);
        setCustomRange({ from: d1, to: d2 });
    };

    const handleSetTime1Offset = (hours) => {
        const refEnd = parseDatetimeLocal(time2Input) || (clock ? new Date(clock) : new Date());
        const newStart = new Date(refEnd.getTime() - hours * 3600 * 1000);
        setTime1Input(toDatetimeLocalString(newStart));
        setRangeError(null);
    };

    const setQuickPreset = (hours) => {
        const end = clock ? new Date(clock) : new Date();
        const start = new Date(end.getTime() - hours * 3600 * 1000);
        setTime1Input(toDatetimeLocalString(start));
        setTime2Input(toDatetimeLocalString(end));
        setRangeError(null);
        setCustomRange({ from: start, to: end });
    };

    const phaseOptions = useMemo(() => {
        return events
            .filter(ev => ev.level === 'Phase')
            .slice(0, 10);
    }, [events]);

    const handlePhaseSelect = (e) => {
        const evId = parseInt(e.target.value, 10);
        const ev = events.find(p => p.id === evId);
        if (!ev) return;
        const start = new Date(ev.started_at);
        const end = ev.ended_at ? new Date(ev.ended_at) : (clock ? new Date(clock) : new Date());
        setTime1Input(toDatetimeLocalString(start));
        setTime2Input(toDatetimeLocalString(end));
        setRangeError(null);
        setCustomRange({ from: start, to: end });
    };

    const handleMouseDown = useCallback((e) => {
        if (e.button !== 0) return; // Left click only
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const { t0, span, x0, cw, y0, ch } = bounds;

        if (mouseX >= x0 && mouseX <= x0 + cw && mouseY >= y0 - 15 && mouseY <= y0 + ch + 15) {
            const frac = Math.max(0, Math.min(1, (mouseX - x0) / cw));
            const time = t0 + frac * span;
            setDragSelection({
                startX: mouseX,
                currentX: mouseX,
                startTime: time,
                currentTime: time
            });
            setHover(null);
        }
    }, [bounds]);

    const handleDoubleClick = useCallback(() => {
        setCustomRange(null);
        setIsCustomRangeOpen(false);
    }, []);

    // Handle mouse hover for crosshair and tooltip
    const handleMouseMove = useCallback((e) => {
        if (dragSelection) return;

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
    }, [bounds, events, activeParams, hiddenTags, selectedReactor, readings, dragSelection]);

    const handleMouseLeave = useCallback(() => {
        if (!dragSelection) {
            setHover(null);
        }
    }, [dragSelection]);

    // Main Canvas Paint Loop
    useEffect(() => {
        if (isCollapsed) return;
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
        const spanHours = span / (3600 * 1000);
        const tickMs = getTickInterval(span);
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
            g.fillText(formatTimeShort(t, spanHours), x, y0 + ch + 16);
        }

        // Right Edge Marker (LIVE in live mode, or TIME 2 in custom range mode)
        const edgeX = x0 + cw;
        if (!customRange) {
            g.strokeStyle = '#2d7a3e';
            g.lineWidth = 1.6;
            g.beginPath();
            g.moveTo(edgeX, y0);
            g.lineTo(edgeX, y0 + ch + 6);
            g.stroke();

            g.fillStyle = '#2d7a3e';
            g.beginPath();
            g.arc(edgeX, y0 + ch + 6, 2.5, 0, 2 * Math.PI);
            g.fill();

            g.font = '600 9px "IBM Plex Sans", sans-serif';
            g.textAlign = 'right';
            g.fillText('LIVE', edgeX - 3, y0 + ch + 16);
        } else {
            g.strokeStyle = '#2563eb';
            g.lineWidth = 1.6;
            g.beginPath();
            g.moveTo(edgeX, y0);
            g.lineTo(edgeX, y0 + ch + 6);
            g.stroke();

            g.fillStyle = '#2563eb';
            g.beginPath();
            g.arc(edgeX, y0 + ch + 6, 2.5, 0, 2 * Math.PI);
            g.fill();

            g.font = '600 9px "IBM Plex Sans", sans-serif';
            g.textAlign = 'right';
            g.fillText('TIME 2', edgeX - 3, y0 + ch + 16);
        }

        // -------------------------------------------------------------
        // 4. Drag Selection Range (Time 1 -> Time 2) Overlay
        // -------------------------------------------------------------
        if (dragSelection) {
            const sx = Math.min(dragSelection.startX, dragSelection.currentX);
            const ex = Math.max(dragSelection.startX, dragSelection.currentX);
            const selW = ex - sx;

            if (selW > 1) {
                // Drag selection shaded box
                g.fillStyle = 'rgba(37, 99, 235, 0.18)';
                g.fillRect(sx, y0, selW, ch);

                // Boundary lines
                g.strokeStyle = '#2563eb';
                g.lineWidth = 1.5;
                g.beginPath();
                g.moveTo(sx + 0.5, y0);
                g.lineTo(sx + 0.5, y0 + ch);
                g.moveTo(ex + 0.5, y0);
                g.lineTo(ex + 0.5, y0 + ch);
                g.stroke();

                const tMin = Math.min(dragSelection.startTime, dragSelection.currentTime);
                const tMax = Math.max(dragSelection.startTime, dragSelection.currentTime);
                const t1Str = formatTime(tMin);
                const t2Str = formatTime(tMax);
                const deltaMs = tMax - tMin;
                const deltaStr = formatDuration(deltaMs);

                // Top duration badge
                g.font = '600 10px "IBM Plex Sans", sans-serif';
                const durText = `Δ ${deltaStr}`;
                const durW = g.measureText(durText).width + 14;
                const durX = Math.max(x0, Math.min(x0 + cw - durW, sx + selW / 2 - durW / 2));
                g.fillStyle = '#2563eb';
                g.beginPath();
                g.roundRect(durX, y0 + 5, durW, 16, 3);
                g.fill();
                g.fillStyle = '#ffffff';
                g.textAlign = 'center';
                g.fillText(durText, durX + durW / 2, y0 + 16.5);

                // Bottom Time 1 and Time 2 badges
                g.font = '600 9.5px "IBM Plex Sans", sans-serif';
                const b1Text = `Time 1: ${t1Str}`;
                const b1W = g.measureText(b1Text).width + 8;
                const b1X = Math.max(x0, Math.min(x0 + cw - b1W, sx - b1W / 2));

                g.fillStyle = '#1e293b';
                g.beginPath();
                g.roundRect(b1X, y0 + ch + 3, b1W, 15, 2);
                g.fill();
                g.fillStyle = '#93c5fd';
                g.textAlign = 'center';
                g.fillText(b1Text, b1X + b1W / 2, y0 + ch + 14);

                const b2Text = `Time 2: ${t2Str}`;
                const b2W = g.measureText(b2Text).width + 8;
                const b2X = Math.max(x0, Math.min(x0 + cw - b2W, ex - b2W / 2));

                g.fillStyle = '#1e293b';
                g.beginPath();
                g.roundRect(b2X, y0 + ch + 3, b2W, 15, 2);
                g.fill();
                g.fillStyle = '#93c5fd';
                g.textAlign = 'center';
                g.fillText(b2Text, b2X + b2W / 2, y0 + ch + 14);
            }
        }

        // -------------------------------------------------------------
        // 5. Interactive Crosshair & Snapping Dots
        // -------------------------------------------------------------
        if (!dragSelection && hover && hover.mouseX >= x0 && hover.mouseX <= x0 + cw) {
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

    }, [isCollapsed, readings, events, clock, selectedReactor, canvasWidth, canvasHeight, timeRange, customRange, dragSelection, hiddenTags, bounds, hover, activeParams, viewMode, laneLayout, overlayUnitInfo, TAG_CONFIG]);

    return (
        <div className={`panel trend ${isCollapsed ? 'collapsed' : ''}`} ref={containerRef}>
            {/* Header: Title, View Mode Picker, Time Range Selector, Reactor Picker, Collapse Button */}
            <div className="thead">
                <div
                    className="trend-title-group trend-title-clickable"
                    onClick={toggleCollapse}
                    title={isCollapsed ? "Click to expand Trend Analysis" : "Click to collapse Trend Analysis"}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <h3>{selectedReactor} Trend Analysis</h3>
                        {isCollapsed && (
                            <span className="trend-collapsed-pill">Collapsed</span>
                        )}
                    </div>
                    <span className="trend-subtitle">
                        {isCollapsed ? 'Click Expand or header to view telemetry' : 'Time-series telemetry & ISA-88 phase overlays'}
                    </span>
                </div>

                <div className="thead-right-actions">
                    {!isCollapsed && (
                        <>
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

                            {/* Time Range Selector: 5m, 15m, 30m, 1h, 3h, 6h, 12h | Custom */}
                            <div className="range-picker" role="group" aria-label="Time range selection">
                                {TIME_RANGES.map(r => (
                                    <button
                                        key={r.label}
                                        type="button"
                                        className={!customRange && Math.abs(timeRange - r.hours) < 0.001 ? 'active' : ''}
                                        onClick={() => {
                                            setCustomRange(null);
                                            setTimeRange(r.hours);
                                        }}
                                        title={`View last ${r.label}`}>
                                        {r.label}
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    className={customRange || isCustomRangeOpen ? 'active custom-btn' : 'custom-btn'}
                                    onClick={toggleCustomRangePanel}
                                    title="Select specific custom time range (Time 1 to Time 2)">
                                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 3 }}>
                                        <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 14.5A6.5 6.5 0 118 1.5a6.5 6.5 0 010 13z" />
                                        <path d="M8 3.5a.75.75 0 00-.75.75v4c0 .2.08.39.22.53l2.5 2.5a.75.75 0 101.06-1.06L8.75 7.94V4.25A.75.75 0 008 3.5z" />
                                    </svg>
                                    Custom
                                </button>
                            </div>
                        </>
                    )}

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

                    {/* Collapse / Expand Toggle Button */}
                    <button
                        type="button"
                        className={`trend-collapse-btn ${isCollapsed ? 'collapsed' : ''}`}
                        onClick={toggleCollapse}
                        title={isCollapsed ? "Expand Trend Canvas" : "Collapse Trend Canvas"}
                        aria-expanded={!isCollapsed}>
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            style={{
                                transition: 'transform 0.2s ease',
                                transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'
                            }}>
                            <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z" />
                        </svg>
                        <span>{isCollapsed ? 'Expand' : 'Collapse'}</span>
                    </button>
                </div>
            </div>

            {/* Collapsible Chart Body */}
            {!isCollapsed && (
                <div className="trend-body">

                    {/* Custom Range Indicator Bar (when custom range is active) */}
                    {customRange && (
                        <div className="custom-range-bar">
                            <div className="cr-info">
                                <span className="cr-icon">⏱</span>
                                <span className="cr-label">Selected Range:</span>
                                <span className="cr-tag time1"><b>Time 1:</b> {formatFullDateTime(customRange.from)}</span>
                                <span className="cr-arrow">→</span>
                                <span className="cr-tag time2"><b>Time 2:</b> {formatFullDateTime(customRange.to)}</span>
                                <span className="cr-duration">({formatDuration(customRange.to - customRange.from)})</span>
                            </div>
                            <div className="cr-actions">
                                <button type="button" onClick={handlePanLeft} title="Pan earlier by 50%">◀ Pan</button>
                                <button type="button" onClick={handlePanRight} title="Pan later by 50%">Pan ▶</button>
                                <button type="button" onClick={handleZoomIn} title="Zoom in 2x">Zoom +</button>
                                <button type="button" onClick={handleZoomOut} title="Zoom out 2x">Zoom &minus;</button>
                                <button
                                    type="button"
                                    className="cr-edit-btn"
                                    onClick={toggleCustomRangePanel}
                                    title="Edit Time 1 and Time 2 values">
                                    {isCustomRangeOpen ? 'Hide Inputs' : 'Edit Range'}
                                </button>
                                <button
                                    type="button"
                                    className="cr-reset-btn"
                                    onClick={handleResetToLive}
                                    title="Exit custom range and return to Live simulator stream">
                                    ✕ Return to Live
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Custom Range Input Panel */}
                    {isCustomRangeOpen && (
                        <div className="custom-range-panel">
                            <form onSubmit={handleApplyCustomRange} className="cr-form">
                                {rangeError && (
                                    <div className="batch-msg-banner error" style={{ marginBottom: '8px' }}>
                                        <span>⚠️ {rangeError}</span>
                                        <button type="button" className="msg-close" onClick={() => setRangeError(null)}>×</button>
                                    </div>
                                )}
                                <div className="cr-inputs-grid">
                                    <div className="cr-input-group">
                                        <label htmlFor="cr-time1">
                                            <span className="cr-badge time1-badge">Time 1</span>
                                            <b>Start Time (From)</b>
                                        </label>
                                        <input
                                            id="cr-time1"
                                            type="text"
                                            placeholder="YYYY-MM-DD HH:mm:ss"
                                            value={time1Input}
                                            onChange={(e) => {
                                                setTime1Input(e.target.value);
                                                setRangeError(null);
                                            }}
                                            required
                                        />
                                    </div>
                                    <div className="cr-input-group">
                                        <label htmlFor="cr-time2">
                                            <span className="cr-badge time2-badge">Time 2</span>
                                            <b>End Time (To)</b>
                                        </label>
                                        <div className="cr-input-with-action">
                                            <input
                                                id="cr-time2"
                                                type="text"
                                                placeholder="YYYY-MM-DD HH:mm:ss"
                                                value={time2Input}
                                                onChange={(e) => {
                                                    setTime2Input(e.target.value);
                                                    setRangeError(null);
                                                }}
                                                required
                                            />
                                            <button
                                                type="button"
                                                className="cr-now-btn"
                                                onClick={() => {
                                                    const nowTime = clock ? new Date(clock) : new Date();
                                                    setTime2Input(toDatetimeLocalString(nowTime));
                                                    setRangeError(null);
                                                }}
                                                title="Set Time 2 to current simulator clock">
                                                Set to Now
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* Quick Presets & Batch Jump */}
                                <div className="cr-presets-row">
                                    <span className="cr-preset-label">Quick Presets:</span>
                                    <button type="button" onClick={() => setQuickPreset(15 / 60)}>Last 15m</button>
                                    <button type="button" onClick={() => setQuickPreset(30 / 60)}>Last 30m</button>
                                    <button type="button" onClick={() => setQuickPreset(1)}>Last 1h</button>
                                    <button type="button" onClick={() => setQuickPreset(3)}>Last 3h</button>
                                    <button type="button" onClick={() => setQuickPreset(6)}>Last 6h</button>
                                    <button type="button" onClick={() => setQuickPreset(12)}>Last 12h</button>
                                    <button type="button" onClick={() => setQuickPreset(24)}>Last 24h</button>
                                    <button type="button" onClick={() => setQuickPreset(72)}>Last 3d</button>

                                    {phaseOptions.length > 0 && (
                                        <div className="cr-phase-select-wrap">
                                            <select
                                                onChange={handlePhaseSelect}
                                                defaultValue=""
                                                title="Jump to a specific batch phase">
                                                <option value="" disabled>Select Recent Batch Phase…</option>
                                                {phaseOptions.map(p => (
                                                    <option key={p.id} value={p.id}>
                                                        {p.batch_id ? `[${p.batch_id}] ` : ''}{p.name} ({formatTime(p.started_at)} {p.ended_at ? '→ ' + formatTime(p.ended_at) : 'Active'})
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                </div>

                                <div className="cr-form-footer">
                                    <span className="cr-tip">
                                        💡 <b>Pro Tip:</b> You can also click and drag horizontally on the chart to select "Time 1" to "Time 2" directly. Double-click the chart to return to Live view.
                                    </span>
                                    <div className="cr-btn-actions">
                                        <button type="button" className="cr-cancel-btn" onClick={() => setIsCustomRangeOpen(false)}>
                                            Close
                                        </button>
                                        {customRange && (
                                            <button type="button" className="cr-reset-live-btn" onClick={handleResetToLive}>
                                                Reset to Live
                                            </button>
                                        )}
                                        <button type="submit" className="cr-apply-btn">
                                            ✓ Apply Time Range
                                        </button>
                                    </div>
                                </div>
                            </form>
                        </div>
                    )}

                    {/* Canvas Container with Interactive Tooltip & Drag Selection */}
                    <div
                        className="trend-canvas-wrap"
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseLeave={handleMouseLeave}
                        onDoubleClick={handleDoubleClick}>
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
            )}
        </div>
    );
}