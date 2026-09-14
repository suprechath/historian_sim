import React, { useRef, useEffect, useState } from 'react';
import { getPhaseSlug } from '../utils/phase';

const TAG_CONFIG = {
    TEMP: { d: 'Temperature', u: '°C', min: 0, max: 120, col: '#b4451f' },
    JKT_TEMP: { d: 'Jacket temp', u: '°C', min: -20, max: 120, col: '#c9822f' },
    PRES: { d: 'Pressure', u: 'bar g', min: -1, max: 6, col: '#1f6e7a' },
    AGIT: { d: 'Agitator', u: 'rpm', min: 0, max: 200, col: '#5d4e8c' },
    VOL: { d: 'Volume', u: 'L', min: 0, max: 5000, col: '#2e5c8a' },
    TURB: { d: 'Turbidity', u: 'NTU', min: 0, max: 1000, col: '#4a7a4a' }
};

const REACTOR_TAGS = {
    R1: ['TEMP', 'JKT_TEMP', 'AGIT', 'VOL'],
    R2: ['TEMP', 'PRES', 'AGIT', 'VOL'],
    R3: ['TEMP', 'TURB', 'AGIT', 'VOL']
};

export default function TrendCanvas({ selectedReactor, onSelectReactor, clock }) {
    const canvasRef = useRef(null);
    const [readings, setReadings] = useState([]);
    const [events, setEvents] = useState([]);
    const [canvasWidth, setCanvasWidth] = useState(700);

    // Watch canvas container size
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ro = new ResizeObserver((entries) => {
            for (let entry of entries) {
                if (entry.contentRect.width > 0) {
                    setCanvasWidth(Math.floor(entry.contentRect.width));
                }
            }
        });
        ro.observe(canvas.parentElement || canvas);
        return () => ro.disconnect();
    }, []);

    // Fetch 3-hour history and phase events on reactor change or periodic sync (every 30s)
    useEffect(() => {
        let isSubscribed = true;

        const fetchData = () => {
            const nowTime = clock ? new Date(clock) : new Date();
            const from = new Date(nowTime.getTime() - 3 * 3600 * 1000);
            const tagList = REACTOR_TAGS[selectedReactor].map(t => `${selectedReactor}.${t}`).join(',');

            Promise.all([
                fetch(`/ui/readings?tags=${tagList}&from=${from.toISOString()}&to=${nowTime.toISOString()}&resolution=raw`).then(r => r.json()),
                fetch(`/ui/events?asset=${selectedReactor}&level=Phase&from=${from.toISOString()}&to=${nowTime.toISOString()}`).then(r => r.json())
            ]).then(([readingsRes, eventsRes]) => {
                if (!isSubscribed) return;
                setReadings(readingsRes.data || []);
                setEvents(eventsRes || []);
            }).catch(console.error);
        };

        fetchData();
        const timer = setInterval(fetchData, 30000);

        return () => {
            isSubscribed = false;
            clearInterval(timer);
        };
    }, [selectedReactor]);

    // Canvas paint loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !clock) return;

        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || 700;
        const h = 250;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.height = `${h}px`;

        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);

        const t1 = new Date(clock).getTime();
        const t0 = t1 - 3 * 3600 * 1000;
        const span = t1 - t0;

        const L = 46, Rp = 46, x0 = L, cw = w - L - Rp, y0 = 8, ch = h - 30;

        // 1. Draw Phase Bands Behind Traces
        events.forEach(ev => {
            const a = Math.max(new Date(ev.started_at).getTime(), t0);
            const b = ev.ended_at ? Math.min(new Date(ev.ended_at).getTime(), t1) : t1;
            if (b < t0 || a > t1) return;

            const bx = x0 + ((a - t0) / span) * cw;
            const bw = ((b - a) / span) * cw;

            const phaseColor = getComputedStyle(document.documentElement).getPropertyValue(`--${getPhaseSlug(ev.name)}`).trim();
            g.fillStyle = phaseColor || '#8d9599';
            g.globalAlpha = 0.14;
            g.fillRect(bx, y0, bw, ch);
            g.globalAlpha = 1;

            g.strokeStyle = '#9aa2a7';
            g.beginPath();
            g.moveTo(bx + 0.5, y0);
            g.lineTo(bx + 0.5, y0 + ch);
            g.stroke();

            if (bw > 52) {
                g.fillStyle = '#4e585e';
                g.font = '10px "IBM Plex Sans", sans-serif';
                g.fillText(ev.name, bx + 4, y0 + 11);
            }
        });

        g.strokeStyle = '#9aa2a7';
        g.lineWidth = 1;
        g.strokeRect(x0 + 0.5, y0 + 0.5, cw, ch);

        // 2. Dual Y-Axis Horizontal Grid Lines
        const activeParams = REACTOR_TAGS[selectedReactor];
        const p1 = TAG_CONFIG[activeParams[0]];
        const p2 = TAG_CONFIG[activeParams[1]];

        g.font = '10px "IBM Plex Sans", sans-serif';
        for (let i = 0; i <= 4; i++) {
            const y = y0 + ch - (i / 4) * ch;
            g.strokeStyle = 'rgba(120,130,136,.26)';
            g.beginPath();
            g.moveTo(x0, y);
            g.lineTo(x0 + cw, y);
            g.stroke();

            g.fillStyle = '#6d777d';
            g.textAlign = 'right';
            g.fillText((p1.min + ((p1.max - p1.min) * i) / 4).toFixed(0), x0 - 6, y + 3);

            g.textAlign = 'left';
            g.fillText((p2.min + ((p2.max - p2.min) * i) / 4).toFixed(0), x0 + cw + 6, y + 3);
        }

        // 3. Draw Continuous Traces with Gaps on NULL
        activeParams.forEach(param => {
            const fullTagName = `${selectedReactor}.${param}`;
            const conf = TAG_CONFIG[param];
            const series = readings.filter(r => r.tag === fullTagName);

            g.strokeStyle = conf.col;
            g.lineWidth = 1.6;
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
                const norm = (pt.value - conf.min) / (conf.max - conf.min);
                const y = Math.max(y0, Math.min(y0 + ch, y0 + ch - norm * ch));

                if (!started) {
                    g.moveTo(x, y);
                    started = true;
                } else {
                    g.lineTo(x, y);
                }
            });
            g.stroke();
        });

    }, [readings, events, clock, selectedReactor, canvasWidth]);

    const activeParams = REACTOR_TAGS[selectedReactor];

    return (
        <div className="panel trend">
            <div className="thead">
                <h3>{selectedReactor} — last 3 hours</h3>
                <div className="tsel" role="group" aria-label="Reactor selection">
                    {['R1', 'R2', 'R3'].map(r => (
                        <button
                            key={r}
                            aria-pressed={selectedReactor === r}
                            onClick={() => onSelectReactor(r)}>
                            {r}
                        </button>
                    ))}
                </div>
            </div>
            <canvas ref={canvasRef} />
            <div className="axnote">
                Left: {TAG_CONFIG[activeParams[0]].d} ({TAG_CONFIG[activeParams[0]].min}–{TAG_CONFIG[activeParams[0]].max} {TAG_CONFIG[activeParams[0]].u}) ·
                Right: {TAG_CONFIG[activeParams[1]].d} ({TAG_CONFIG[activeParams[1]].min}–{TAG_CONFIG[activeParams[1]].max} {TAG_CONFIG[activeParams[1]].u})
            </div>
            <div className="legend">
                {activeParams.map(p => (
                    <span key={p}>
                        <i style={{ background: TAG_CONFIG[p].col }} />
                        {TAG_CONFIG[p].d}
                    </span>
                ))}
            </div>
        </div>
    );
}