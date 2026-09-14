import React from 'react';
import { getPhaseSlug } from '../utils/phase';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function getLiqCol(temp) {
    const t = temp || 20;
    const x = clamp((t - 10) / 80, 0, 1);
    const a = [46, 110, 138];
    const b = [180, 69, 31];
    const rgb = a.map((c, i) => Math.round(c + (b[i] - c) * x));
    return `rgb(${rgb.join(',')})`;
}

function formatUnit(u) {
    if (!u) return '';
    if (u === 'degC') return '°C';
    if (u === 'degC/h') return '°C/h';
    if (u === 'bar g') return 'bar';
    return u;
}

function getModeInfo(tag) {
    if (!tag) return { label: '—', bg: '#abb2b7', textCol: '#1f2529' };
    let label = tag.state_label;
    const v = tag.val !== null && tag.val !== undefined ? Number(tag.val) : null;

    if (!label && tag.name) {
        if (tag.name.endsWith('AGIT_RUN')) label = v === 1 ? 'Running' : 'Stopped';
        else if (tag.name.endsWith('JKT_MODE')) label = v === 1 ? 'Heating' : v === 2 ? 'Cooling' : 'Idle';
        else if (tag.name.endsWith('N2_BLANKET')) label = v === 1 ? 'OK' : 'Lost';
        else if (tag.name.endsWith('DOSE_PUMP')) label = v === 1 ? 'On' : 'Off';
        else if (tag.name.endsWith('COOL_RAMP')) label = v === 1 ? 'Ramping' : 'Hold';
        else if (tag.name.endsWith('SEEDED')) label = v === 1 ? 'Yes' : 'No';
        else label = v !== null ? String(v) : '—';
    }
    if (!label) label = '—';

    const isAlarm = Boolean(tag.alarm || label === 'Lost');
    let bg = '#abb2b7';
    let textCol = '#252d31';

    if (isAlarm) {
        bg = 'var(--alarm)';
        textCol = '#ffffff';
    } else if (label === 'Heating') {
        bg = 'var(--hot)';
        textCol = '#ffffff';
    } else if (label === 'Cooling' || label === 'Ramping') {
        bg = 'var(--cold)';
        textCol = '#ffffff';
    } else if (label === 'Running' || label === 'OK' || label === 'On' || label === 'Yes') {
        bg = 'var(--ok)';
        textCol = '#ffffff';
    } else {
        // Inactive states: Stopped, Idle, Off, Hold, No
        bg = '#abb2b7';
        textCol = '#252d31';
    }

    return { label, bg, textCol };
}

export default function ProcessMimic({ reactors, tags, selectedReactor, onSelectReactor, running = true, speed = 1 }) {
    const getTag = (name) => tags.find(t => t.name === name) || { val: null, q: 'Bad', u: '', alarm: false };

    // Calibrated speed multipliers for clear visual distinction:
    // 1x   -> 1.0x (steady industrial churn, ~1.5s per turn at 100 RPM)
    // 60x  -> 3.5x faster (~0.43s per turn, unmistakably fast-forwarding)
    // 300x -> 10.0x faster (~0.14s per turn, peak turbo whirl right at safe 60Hz limit)
    const speedFactor =
        speed >= 300 ? 10.0 :
            speed >= 60 ? 3.5 :
                1.0;

    // Reactor Tag Lookups (All 8 tags per vessel)
    const rData = {
        R1: {
            temp: getTag('R1.TEMP'),
            jkt: getTag('R1.JKT_TEMP'),
            pres: getTag('R1.PRES'),
            agit: getTag('R1.AGIT'),
            vol: getTag('R1.VOL'),
            agitRun: getTag('R1.AGIT_RUN'),
            jktMode: getTag('R1.JKT_MODE'),
            n2: getTag('R1.N2_BLANKET'),
            cap: 5000,
            name: 'R1 Reaction'
        },
        R2: {
            temp: getTag('R2.TEMP'),
            ph: getTag('R2.PH'),
            doseFlow: getTag('R2.DOSE_FLOW'),
            doseTotal: getTag('R2.DOSE_TOTAL'),
            vol: getTag('R2.VOL'),
            agitRun: getTag('R2.AGIT_RUN'),
            dosePump: getTag('R2.DOSE_PUMP'),
            n2: getTag('R2.N2_BLANKET'),
            cap: 5000,
            name: 'R2 Workup'
        },
        R3: {
            temp: getTag('R3.TEMP'),
            coolRate: getTag('R3.COOL_RATE'),
            agit: getTag('R3.AGIT'),
            turb: getTag('R3.TURB'),
            vol: getTag('R3.VOL'),
            agitRun: getTag('R3.AGIT_RUN'),
            coolRamp: getTag('R3.COOL_RAMP'),
            seeded: getTag('R3.SEEDED'),
            cap: 3000,
            name: 'R3 Crystalliser'
        }
    };

    const r1Rows = [
        { label: 'Temp', tag: rData.R1.temp, type: 'value', unit: '°C' },
        { label: 'Jacket', tag: rData.R1.jkt, type: 'value', unit: '°C' },
        { label: 'Pressure', tag: rData.R1.pres, type: 'value', unit: 'bar' },
        { label: 'Agit', tag: rData.R1.agit, type: 'value', unit: 'rpm' },
        { label: 'Volume', tag: rData.R1.vol, type: 'value', unit: 'L' },
        { label: 'Agitator', tag: rData.R1.agitRun, type: 'mode' },
        { label: 'Jkt Mode', tag: rData.R1.jktMode, type: 'mode' },
        { label: 'N2 Blanket', tag: rData.R1.n2, type: 'mode' },
    ];

    const r2Rows = [
        { label: 'Temp', tag: rData.R2.temp, type: 'value', unit: '°C' },
        { label: 'pH', tag: rData.R2.ph, type: 'value', unit: 'pH' },
        { label: 'Dose Flow', tag: rData.R2.doseFlow, type: 'value', unit: 'L/h' },
        { label: 'Dose Total', tag: rData.R2.doseTotal, type: 'value', unit: 'L' },
        { label: 'Volume', tag: rData.R2.vol, type: 'value', unit: 'L' },
        { label: 'Agitator', tag: rData.R2.agitRun, type: 'mode' },
        { label: 'Dose Pump', tag: rData.R2.dosePump, type: 'mode' },
        { label: 'N2 Blanket', tag: rData.R2.n2, type: 'mode' },
    ];

    const r3Rows = [
        { label: 'Temp', tag: rData.R3.temp, type: 'value', unit: '°C' },
        { label: 'Cool Rate', tag: rData.R3.coolRate, type: 'value', unit: '°C/h' },
        { label: 'Agit', tag: rData.R3.agit, type: 'value', unit: 'rpm' },
        { label: 'Turbidity', tag: rData.R3.turb, type: 'value', unit: 'NTU' },
        { label: 'Volume', tag: rData.R3.vol, type: 'value', unit: 'L' },
        { label: 'Agitator', tag: rData.R3.agitRun, type: 'mode' },
        { label: 'Cool Ramp', tag: rData.R3.coolRamp, type: 'mode' },
        { label: 'Seeded', tag: rData.R3.seeded, type: 'mode' },
    ];

    const renderReadoutTile = (x0, rows) => {
        const tileW = 144;
        const tileH = 156;
        const tileY = 96;

        return (
            <g className="readout-tile">
                <rect x={x0} y={tileY} width={tileW} height={tileH} rx="3" fill="var(--panel-2)" stroke="var(--edge)" />
                {rows.map((row, idx) => {
                    const yBase = 113 + idx * 18;
                    const rightEdge = x0 + tileW - 8;

                    return (
                        <g key={row.label}>
                            <text x={x0 + 8} y={yBase} fontSize="10.5" fill="var(--ink-2)">
                                {row.label}
                            </text>
                            {row.type === 'mode' ? (() => {
                                const mode = getModeInfo(row.tag);
                                const badgeW = Math.max(32, mode.label.length * 6 + 12);
                                const badgeX = rightEdge - badgeW;
                                const badgeY = yBase - 10.5;

                                return (
                                    <g className="mode-badge">
                                        <rect
                                            x={badgeX}
                                            y={badgeY}
                                            width={badgeW}
                                            height={13.5}
                                            rx="2.5"
                                            fill={mode.bg}
                                        />
                                        <text
                                            x={badgeX + badgeW / 2}
                                            y={yBase}
                                            fontSize="9.5"
                                            fontWeight="600"
                                            fill={mode.textCol}
                                            textAnchor="middle"
                                        >
                                            {mode.label}
                                        </text>
                                    </g>
                                );
                            })() : (
                                <text
                                    x={rightEdge}
                                    y={yBase}
                                    fontSize="11.5"
                                    fontWeight="500"
                                    fill={row.tag?.alarm ? 'var(--alarm)' : (row.tag?.q === 'Bad' ? 'var(--ink-3)' : 'var(--ink)')}
                                    textAnchor="end"
                                >
                                    {row.tag?.val !== null && row.tag?.val !== undefined
                                        ? `${row.tag.val} ${row.unit || formatUnit(row.tag?.u)}`
                                        : '—'}
                                </text>
                            )}
                        </g>
                    );
                })}
            </g>
        );
    };

    const f1Active = reactors?.R1?.phase === 'Transfer';
    const f2Active = reactors?.R2?.phase === 'Transfer';

    const handleKeyDown = (e, reactor) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectReactor(reactor);
        }
    };

    const renderTurbine = (cx, cy, rpm) => {
        const isSpinning = running && (rpm || 0) > 0;
        const baseDuration = (rpm > 0) ? (150 / rpm) : 0;
        const duration = isSpinning
            ? Math.max(0.14, baseDuration / speedFactor).toFixed(2) + 's'
            : '0s';

        return (
            <g className="turbine-assembly">
                {/* Shaft coupling collar */}
                <rect x={cx - 3.5} y={cy - 12} width="7" height="9" rx="1" fill="#444c52" stroke="#252a2d" strokeWidth="0.8" />
                <line x1={cx - 3} y1={cy - 7.5} x2={cx + 3} y2={cy - 7.5} stroke="#7a868e" strokeWidth="0.8" />

                {/* Turbine Impeller in 3D perspective */}
                <g transform={`translate(${cx}, ${cy})`}>
                    <g transform="scale(1, 0.36)">
                        <g
                            className="turbine-rotor"
                            style={{
                                transformOrigin: '0px 0px',
                                animationName: isSpinning ? 'turbineSpin' : 'none',
                                animationDuration: duration,
                                animationTimingFunction: 'linear',
                                animationIterationCount: 'infinite',
                                animationPlayState: running ? 'running' : 'paused'
                            }}
                        >
                            <use href="#turbine-blade" />
                            <use href="#turbine-blade" transform="rotate(90)" />
                            <use href="#turbine-blade" transform="rotate(180)" />
                            <use href="#turbine-blade" transform="rotate(270)" />
                            {/* Hub flange plate */}
                            <circle cx="0" cy="0" r="7.5" fill="#363e43" stroke="#1b2023" strokeWidth="1" />
                            {/* Hex nut / shaft cap */}
                            <circle cx="0" cy="0" r="3.8" fill="#6d7981" stroke="#202528" strokeWidth="0.7" />
                            <circle cx="0" cy="0" r="1.6" fill="#b5c1c8" />
                        </g>
                    </g>
                </g>
                {/* Lower retaining tip */}
                <polygon points={`${cx - 2.5},${cy + 2} ${cx + 2.5},${cy + 2} ${cx},${cy + 5.5}`} fill="#2a3136" />
            </g>
        );
    };

    const getJacketFill = (reactorKey) => {
        const HOT_COLOR = 'rgba(180, 69, 31, 0.5)';
        const COLD_COLOR = 'rgba(46, 110, 138, 0.5)';
        const IDLE_COLOR = 'rgba(125, 134, 140, 0.08)';

        if (reactorKey === 'R1') {
            const mode = Number(rData.R1.jktMode?.val);
            if (mode === 1 || rData.R1.jktMode?.state_label === 'Heating') return HOT_COLOR;
            if (mode === 2 || rData.R1.jktMode?.state_label === 'Cooling') return COLD_COLOR;
            return IDLE_COLOR;
        }

        if (reactorKey === 'R2') {
            const p = reactors?.R2?.phase;
            const temp = rData.R2.temp?.val || 0;
            // Hot: Solvent boil-off distillation or hot CIP cleaning cycle
            if (p === 'Solvent swap' || (p === 'Clean' && temp > 35)) return HOT_COLOR;
            // Cold: Chilled jacket during exothermic acid-base neutralization
            if (p === 'pH adjust' && temp > 32) return COLD_COLOR;
            return IDLE_COLOR;
        }

        if (reactorKey === 'R3') {
            const p = reactors?.R3?.phase;
            const temp = rData.R3.temp?.val || 0;
            const coolRate = rData.R3.coolRate?.val || 0;
            const coolRamp = Number(rData.R3.coolRamp?.val);
            // Hot: Thermal dissolution of crystal solids or hot CIP cleaning cycle
            if (p === 'Heat to dissolve' || (p === 'Clean' && temp > 35)) return HOT_COLOR;
            // Cold: Active controlled cooling ramp or sub-ambient chilled hold (5 °C)
            if (p === 'Cooling ramp' || p === 'Age' || coolRamp === 1 || coolRate < -0.5) return COLD_COLOR;
            return IDLE_COLOR;
        }

        return IDLE_COLOR;
    };

    return (
        <div className="panel mimic">
            <svg viewBox="0 0 1180 330" aria-label="Process mimic">
                <defs>
                    <clipPath id="c1"><path d="M90 100 L90 196 Q90 224 132 224 Q174 224 174 196 L174 100 Z" /></clipPath>
                    <clipPath id="c2"><path d="M470 100 L470 196 Q470 224 512 224 Q554 224 554 196 L554 100 Z" /></clipPath>
                    <clipPath id="c3"><path d="M850 100 L850 196 Q850 224 892 224 Q934 224 934 196 L934 100 Z" /></clipPath>

                    {/* Industrial Pitched Turbine Blade */}
                    <g id="turbine-blade">
                        <path d="M 5 -3.5 L 24 -6.5 C 27 -6.5 28.5 -2.5 26.5 3.5 L 5 4 Z" fill="#353c42" stroke="#1b2023" strokeWidth="0.8" />
                        <path d="M 5 -3.5 L 24 -6.5 L 25.5 -1 L 5 0.5 Z" fill="#7d8a92" opacity="0.85" />
                        <line x1="5" y1="-3.5" x2="24" y2="-6.5" stroke="#c0cbd2" strokeWidth="0.7" />
                    </g>
                </defs>

                {/* Transfer Piping */}
                <path
                    d="M132 224 L132 296 L360 296 L360 46 L512 46 L512 60"
                    fill="none"
                    stroke={f1Active ? 'var(--flow)' : 'var(--edge-dark)'}
                    strokeWidth="2.5"
                    strokeDasharray={f1Active ? '9 6' : ''}
                    className={f1Active ? 'pipe-active' : ''}
                    style={f1Active ? {
                        animationDuration: `${(0.85 / Math.min(speedFactor, 4)).toFixed(2)}s`,
                        animationPlayState: running ? 'running' : 'paused'
                    } : {}}
                />
                <path
                    d="M512 224 L512 296 L740 296 L740 46 L892 46 L892 60"
                    fill="none"
                    stroke={f2Active ? 'var(--flow)' : 'var(--edge-dark)'}
                    strokeWidth="2.5"
                    strokeDasharray={f2Active ? '9 6' : ''}
                    className={f2Active ? 'pipe-active' : ''}
                    style={f2Active ? {
                        animationDuration: `${(0.85 / Math.min(speedFactor, 4)).toFixed(2)}s`,
                        animationPlayState: running ? 'running' : 'paused'
                    } : {}}
                />
                <path d="M892 224 L892 296 L1010 296" fill="none" stroke="var(--edge-dark)" strokeWidth="2.5" strokeDasharray="5 4" opacity=".6" />

                {/* Transfer Pumps */}
                <circle cx="246" cy="296" r="10" fill="var(--panel)" stroke={f1Active ? 'var(--flow)' : 'var(--edge-dark)'} strokeWidth="1.5" />
                <path d="M241 290 L253 296 L241 302 Z" fill={f1Active ? 'var(--flow)' : 'var(--edge-dark)'} />
                <circle cx="626" cy="296" r="10" fill="var(--panel)" stroke={f2Active ? 'var(--flow)' : 'var(--edge-dark)'} strokeWidth="1.5" />
                <path d="M621 290 L633 296 L621 302 Z" fill={f2Active ? 'var(--flow)' : 'var(--edge-dark)'} />

                {/* Out-of-Scope Downstream Placeholder */}
                <rect x="1010" y="278" width="86" height="36" rx="3" fill="var(--panel-2)" stroke="var(--edge)" strokeDasharray="4 3" />
                <text x="1053" y="294" fontSize="11" fill="var(--ink-3)" textAnchor="middle">Filter, dryer</text>
                <text x="1053" y="307" fontSize="10" fill="var(--ink-3)" textAnchor="middle">not monitored</text>

                {/* R1 Vessel Graphic */}
                <g
                    className="vessel-hit"
                    role="button"
                    tabIndex={0}
                    aria-label="Select Reactor R1"
                    onClick={() => onSelectReactor('R1')}
                    onKeyDown={(e) => handleKeyDown(e, 'R1')}
                >
                    {/* Heating / Cooling Jacket offset from vessel boundary (behind) */}
                    <path
                        className="vjacket"
                        d="M90 118 L84 118 L84 196 Q84 230 132 230 Q180 230 180 196 L180 118 L174 118"
                        fill={getJacketFill('R1')}
                        stroke={selectedReactor === 'R1' ? '#5c666c' : '#7d868c'}
                        strokeWidth="1.6"
                    />
                    <line x1="84" y1="208" x2="78" y2="208" stroke="#7d868c" strokeWidth="1.6" />
                    <line x1="84" y1="130" x2="78" y2="130" stroke="#7d868c" strokeWidth="1.6" />
                    <g clipPath="url(#c1)">
                        <rect x="90" y="100" width="84" height="126" fill="#c2c8cc" />
                        <rect x="90"
                            y={224 - 124 * clamp((rData.R1.vol.val || 0) / rData.R1.cap, 0, 1)}
                            width="84"
                            height={124 * clamp((rData.R1.vol.val || 0) / rData.R1.cap, 0, 1) + 6}
                            fill={getLiqCol(rData.R1.temp.val)} opacity="1" />
                    </g>
                    <path className="vbody" d="M90 100 L90 196 Q90 224 132 224 Q174 224 174 196 L174 100 Z"
                        fill="none" stroke={selectedReactor === 'R1' ? 'var(--selected)' : '#6c5c5cff'} strokeWidth={selectedReactor === 'R1' ? '4' : '1.8'} />
                    <line x1="84" y1="100" x2="180" y2="100" stroke="#5c666c" strokeWidth="1.8" />
                    <rect x="119" y="62" width="26" height="18" rx="2" fill="var(--panel)" stroke="#5c666c" strokeWidth="1.4" />
                    <line x1="132" y1="80" x2="132" y2="188" stroke="#5c666c" strokeWidth="1.8" />
                    {renderTurbine(132, 188, rData.R1.agit.val)}
                    <text x="225" y="90" fontSize="13" fontWeight="600" fill="var(--ink)" textAnchor="middle">R1 reaction</text>
                    <rect x="88" y="262" width="88" height="19" rx="2" fill={`var(--${getPhaseSlug(reactors?.R1?.phase)})`} />
                    <text x="132" y="275" fontSize="11" fill="#fff" textAnchor="middle">{reactors?.R1?.phase || 'Idle'}</text>
                </g>

                {/* R1 Readout Tiles */}
                {renderReadoutTile(188, r1Rows)}

                {/* R2 Vessel Graphic */}
                <g
                    className="vessel-hit"
                    role="button"
                    tabIndex={0}
                    aria-label="Select Reactor R2"
                    onClick={() => onSelectReactor('R2')}
                    onKeyDown={(e) => handleKeyDown(e, 'R2')}
                >
                    {/* Heating / Cooling Jacket offset from vessel boundary (behind) */}
                    <path
                        className="vjacket"
                        d="M470 118 L464 118 L464 196 Q464 230 512 230 Q560 230 560 196 L560 118 L554 118"
                        fill={getJacketFill('R2')}
                        stroke={selectedReactor === 'R2' ? '#5c666c' : '#7d868c'}
                        strokeWidth="1.6"
                    />
                    <line x1="464" y1="208" x2="458" y2="208" stroke="#7d868c" strokeWidth="1.6" />
                    <line x1="464" y1="130" x2="458" y2="130" stroke="#7d868c" strokeWidth="1.6" />
                    <g clipPath="url(#c2)">
                        <rect x="470" y="100" width="84" height="126" fill="#c2c8cc" />
                        <rect x="470"
                            y={224 - 124 * clamp((rData.R2.vol.val || 0) / rData.R2.cap, 0, 1)}
                            width="84"
                            height={124 * clamp((rData.R2.vol.val || 0) / rData.R2.cap, 0, 1) + 6}
                            fill={getLiqCol(rData.R2.temp.val)} opacity="1" />
                    </g>
                    <path className="vbody" d="M470 100 L470 196 Q470 224 512 224 Q554 224 554 196 L554 100 Z"
                        fill="none" stroke={selectedReactor === 'R2' ? 'var(--selected)' : '#5c666c'} strokeWidth={selectedReactor === 'R2' ? '4' : '1.8'} />
                    <line x1="464" y1="100" x2="560" y2="100" stroke="#5c666c" strokeWidth="1.8" />
                    <rect x="499" y="62" width="26" height="18" rx="2" fill="var(--panel)" stroke="#5c666c" strokeWidth="1.4" />
                    <line x1="512" y1="80" x2="512" y2="188" stroke="#5c666c" strokeWidth="1.8" />
                    {renderTurbine(512, 188, (Number(rData.R2.agitRun?.val) === 1 || rData.R2.agitRun?.state_label === 'Running') ? 80 : 0)}
                    <text x="604" y="90" fontSize="13" fontWeight="600" fill="var(--ink)" textAnchor="middle">R2 Workup</text>
                    <rect x="468" y="262" width="88" height="19" rx="2" fill={`var(--${getPhaseSlug(reactors?.R2?.phase)})`} />
                    <text x="512" y="275" fontSize="11" fill="#fff" textAnchor="middle">{reactors?.R2?.phase || 'Idle'}</text>
                </g>

                {/* R2 Readout Tiles */}
                {renderReadoutTile(570, r2Rows)}

                {/* R3 Vessel Graphic */}
                <g
                    className="vessel-hit"
                    role="button"
                    tabIndex={0}
                    aria-label="Select Reactor R3"
                    onClick={() => onSelectReactor('R3')}
                    onKeyDown={(e) => handleKeyDown(e, 'R3')}
                >
                    {/* Heating / Cooling Jacket offset from vessel boundary (behind) */}
                    <path
                        className="vjacket"
                        d="M850 118 L844 118 L844 196 Q844 230 892 230 Q940 230 940 196 L940 118 L934 118"
                        fill={getJacketFill('R3')}
                        stroke={selectedReactor === 'R3' ? '#5c666c' : '#7d868c'}
                        strokeWidth="1.6"
                    />
                    <line x1="844" y1="208" x2="838" y2="208" stroke="#7d868c" strokeWidth="1.6" />
                    <line x1="844" y1="130" x2="838" y2="130" stroke="#7d868c" strokeWidth="1.6" />
                    <g clipPath="url(#c3)">
                        <rect x="850" y="100" width="84" height="126" fill="#c2c8cc" />
                        <rect x="850"
                            y={224 - 124 * clamp((rData.R3.vol.val || 0) / rData.R3.cap, 0, 1)}
                            width="84"
                            height={124 * clamp((rData.R3.vol.val || 0) / rData.R3.cap, 0, 1) + 6}
                            fill={getLiqCol(rData.R3.temp.val)} opacity="1" />
                    </g>
                    <path className="vbody" d="M850 100 L850 196 Q850 224 892 224 Q934 224 934 196 L934 100 Z"
                        fill="none" stroke={selectedReactor === 'R3' ? 'var(--selected)' : '#5c666c'} strokeWidth={selectedReactor === 'R3' ? '4' : '1.8'} />
                    <line x1="844" y1="100" x2="940" y2="100" stroke="#5c666c" strokeWidth="1.8" />
                    <rect x="879" y="62" width="26" height="18" rx="2" fill="var(--panel)" stroke="#5c666c" strokeWidth="1.4" />
                    <line x1="892" y1="80" x2="892" y2="188" stroke="#5c666c" strokeWidth="1.8" />
                    {renderTurbine(892, 188, rData.R3.agit.val)}
                    <text x="995" y="90" fontSize="13" fontWeight="600" fill="var(--ink)" textAnchor="middle">R3 crystalliser</text>
                    <rect x="848" y="262" width="88" height="19" rx="2" fill={`var(--${getPhaseSlug(reactors?.R3?.phase)})`} />
                    <text x="892" y="275" fontSize="11" fill="#fff" textAnchor="middle">{reactors?.R3?.phase || 'Idle'}</text>
                </g>

                {/* R3 Readout Tiles */}
                {renderReadoutTile(948, r3Rows)}
            </svg>
        </div>
    );
}