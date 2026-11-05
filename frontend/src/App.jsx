import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import HealthCheckDialog from './components/HealthCheckDialog';
import PlantOverview from './pages/PlantOverview';
import ScheduledTasks from './pages/ScheduledTasks';
import ConfigurePage from './pages/ConfigurePage';
import { useHistorianStream } from './hooks/useHistorianStream';

export default function App() {
    const stream = useHistorianStream();
    const [currentPage, setCurrentPage] = useState('overview'); // 'overview' | 'scheduled' | 'configure'
    const [dismissedHealthCheckId, setDismissedHealthCheckId] = useState(null);

    // Sync active page from browser URL (Pathname /configure or Hash #scheduled / #overview / #configure)
    useEffect(() => {
        const handleLocationChange = () => {
            const pathname = window.location.pathname.toLowerCase();
            const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();

            if (pathname.includes('/configure') || hash === 'configure' || hash === 'config') {
                setCurrentPage('configure');
            } else if (hash === 'scheduled' || hash === 'tasks' || hash === 'queue' || pathname.includes('/scheduled')) {
                setCurrentPage('scheduled');
            } else {
                setCurrentPage('overview');
            }
        };

        handleLocationChange();
        window.addEventListener('hashchange', handleLocationChange);
        window.addEventListener('popstate', handleLocationChange);
        return () => {
            window.removeEventListener('hashchange', handleLocationChange);
            window.removeEventListener('popstate', handleLocationChange);
        };
    }, []);

    const handleNavigate = (pageKey) => {
        setCurrentPage(pageKey);
        if (pageKey === 'configure') {
            window.history.pushState(null, '', '/configure');
        } else if (pageKey === 'scheduled') {
            window.history.pushState(null, '', '/#scheduled');
        } else {
            window.history.pushState(null, '', '/');
        }
    };

    // Callback when operator clicks close / acknowledge on the HEALTH_CHECK dialogue
    const handleCloseHealthCheck = async (healthRecord) => {
        const record = (healthRecord && typeof healthRecord === 'object' && healthRecord.id)
            ? healthRecord
            : stream.integrationHealth;

        const recordId = record?.id || 'dismissed';
        setDismissedHealthCheckId(recordId);

        if (!record?.id) return;

        try {
            await fetch('/ui/integration/health/close', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: record.id, batchId: record.batch_id })
            });
        } catch (err) {
            console.error('Failed to acknowledge health check dialog:', err);
        }
    };

    // Determine if on-demand alert popup should be visible
    const showOnDemandAlert = Boolean(
        stream.integrationHealth?.isRecentOnDemand &&
        dismissedHealthCheckId !== stream.integrationHealth?.id
    );

    // Dynamic browser document title indicating plant health and active batch
    useEffect(() => {
        const health = stream.integrationHealth;
        const healthTag = health ? (health.status === 'passed' ? '🟢 OK' : '🔴 DEGRADED') : '⚪ CONNECTING';
        const batchTag = stream.mode === 'single' && stream.assignedBatchId
            ? `[${stream.assignedBatchId}]`
            : '[Train Mode]';
        const pageTag = currentPage === 'scheduled' 
            ? 'Scheduled Tasks' 
            : currentPage === 'configure' 
            ? 'Template Configuration' 
            : 'Plant Overview';
        document.title = `${healthTag} ${batchTag} Plant Historian — ${pageTag}`;
    }, [
        stream.integrationHealth?.status,
        stream.mode,
        stream.assignedBatchId,
        currentPage
    ]);

    // Keyboard navigation shortcuts
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
            if (e.key === 'Escape' && showOnDemandAlert && stream.integrationHealth) {
                handleCloseHealthCheck(stream.integrationHealth);
            }
            if ((e.key === '1' || e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.altKey && !e.metaKey) {
                handleNavigate('overview');
            }
            if ((e.key === '2' || e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.altKey && !e.metaKey) {
                handleNavigate('scheduled');
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showOnDemandAlert, stream.integrationHealth?.id, stream.integrationHealth?.batch_id]);

    return (
        <div className="layout">
            {/* On-Demand Health Check Operator Alert Dialogue */}
            {showOnDemandAlert && stream.integrationHealth && (
                <HealthCheckDialog
                    health={stream.integrationHealth}
                    onDismiss={handleCloseHealthCheck}
                />
            )}

            {/* Global Industrial SCADA Header (No button to /configure) */}
            <Header
                clock={stream.clock}
                running={stream.running}
                speed={stream.speed}
                connected={stream.connected}
                mode={stream.mode}
                assignedBatchId={stream.assignedBatchId}
                singleBatchStatus={stream.singleBatchStatus}
                integrationHealth={stream.integrationHealth}
                integrationConnected={stream.integrationConnected}
                pendingOutboundCount={stream.pendingOutboundCount || 0}
                activePage={currentPage}
                onNavigate={handleNavigate}
                pendingScheduledCount={stream.pendingScheduledCount || 0}
            />

            {/* Active View: Process Mimic vs Scheduled Tasks vs Configure Page */}
            {currentPage === 'scheduled' ? (
                <ScheduledTasks
                    stream={stream}
                    onNavigate={handleNavigate}
                />
            ) : currentPage === 'configure' ? (
                <ConfigurePage
                    onNavigate={handleNavigate}
                />
            ) : (
                <PlantOverview
                    stream={stream}
                />
            )}
        </div>
    );
}
