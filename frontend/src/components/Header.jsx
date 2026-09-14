import React from 'react';

function formatDate(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
        `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

export default function Header({ clock, running, speed, connected }) {
    const handleSpeed = async (newSpeed, newRunning) => {
        try {
            await fetch('/ui/simulation/state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ speed: newSpeed, running: newRunning })
            });
        } catch (err) {
            console.error('Speed change error:', err);
        }
    };

    return (
        <header>
            <div className="brand">
                API Plant Historian <span>— Process overview</span>
            </div>
            <div className="clock">
                {formatDate(clock)} <small>UTC+0</small>
            </div>
            <div className="hdr-r">
                <div className={`live ${!running || !connected ? 'paused' : ''}`}>
                    <i />
                    <span>{!connected ? 'Disconnected' : !running ? 'Paused' : 'Live'}</span>
                </div>
                <div className="speed" role="group" aria-label="Simulation speed">
                    <button
                        aria-pressed={running && speed === 1}
                        onClick={() => handleSpeed(1, true)}>
                        1&times;
                    </button>
                    <button
                        aria-pressed={running && speed === 60}
                        onClick={() => handleSpeed(60, true)}>
                        60&times;
                    </button>
                    <button
                        aria-pressed={running && speed === 300}
                        onClick={() => handleSpeed(300, true)}>
                        300&times;
                    </button>
                    <button
                        aria-pressed={!running}
                        onClick={() => handleSpeed(speed || 1, !running)}>
                        {running ? 'Pause' : 'Resume'}
                    </button>
                </div>
            </div>
        </header>
    );
}