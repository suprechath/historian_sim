import React from 'react';

export default function TagTable({ tags, reactors }) {
    const grouped = {
        R1: tags.filter(t => t.asset === 'R1'),
        R2: tags.filter(t => t.asset === 'R2'),
        R3: tags.filter(t => t.asset === 'R3')
    };

    const reactorNames = {
        R1: 'Reaction 1',
        R2: 'Workup 2',
        R3: 'Crystalliser 3'
    };

    return (
        <div className="panel tagtbl">
            <table>
                <thead>
                    <tr>
                        <th>Tag</th>
                        <th>Parameter</th>
                        <th style={{ textAlign: 'right' }}>Value</th>
                        <th></th>
                        <th>Quality</th>
                    </tr>
                </thead>
                <tbody>
                    {['R1', 'R2', 'R3'].map(r => (
                        <React.Fragment key={r}>
                            <tr className="grp">
                                <td colSpan="5">
                                    {r} — {reactorNames[r]}
                                    {reactors?.[r]?.batchId ? ` · ${reactors[r].batchId}` : ''} · {reactors?.[r]?.phase || 'Idle'}
                                </td>
                            </tr>
                            {grouped[r].map(t => {
                                const isBad = t.q === 'Bad';
                                const isAlarm = t.alarm;
                                return (
                                    <tr key={t.name}>
                                        <td className="mono">{t.name}</td>
                                        <td style={{ color: 'var(--ink-2)' }}>{t.parameter}</td>
                                        <td className={`v ${isBad ? 'bad' : isAlarm ? 'alarm' : ''}`}>
                                            {t.val !== null ? (t.state_label ? `${t.val} (${t.state_label})` : t.val) : '—'}
                                        </td>
                                        <td className="u">{t.u || ''}</td>
                                        <td>
                                            <span className={`q ${t.q}`}>{t.q}</span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </React.Fragment>
                    ))}
                </tbody>
            </table>
        </div>
    );
}