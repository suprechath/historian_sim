import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import PlantOverview from './pages/PlantOverview';
import ScheduledTasks from './pages/ScheduledTasks';
import HealthCheckDialog from './components/HealthCheckDialog';
import { useHistorianStream } from './hooks/useHistorianStream';

export default function App() {
    const stream = useHistorianStream();

    // Determine initial page from URL hash
    const [currentPage, setCurrentPage] = useState(() => {
        const hash = (typeof window !== 'undefined' ? window.location.hash : '').toLowerCase();
        if (hash.includes('scheduled')) return 'scheduled';
        return 'overview';
    });

    const [dismissedHealthCheckId, setDismissedHealthCheckId] = useState(null);

    // Sync hash changes with currentPage
    useEffect(() => {
        const handleHashChange = () => {
            const hash = window.location.hash.toLowerCase();
            if (hash.includes('scheduled')) {
                setCurrentPage('scheduled');
            } else {
                setCurrentPage('overview');
            }
        };

        window.addEventListener('hashchange', handleHashChange);
        return () => window.removeEventListener('hashchange', handleHashChange);
    }, []);

    const handleNavigate = (page) => {
        setCurrentPage(page);
        if (page === 'scheduled') {
            window.location.hash = '#/scheduled';
        } else {
            window.location.hash = '#/overview';
        }
    };

    // Health check dialog popup handling
    const showOnDemandAlert = Boolean(
        stream.integrationHealth?.isRecentOnDemand &&
        dismissedHealthCheckId !== stream.integrationHealth?.id
    );

    const handleCloseHealthCheck = async () => {
        const health = stream.integrationHealth;
        if (!health?.id) return;

        setDismissedHealthCheckId(health.id);

        try {
            await fetch('/ui/integration/health/close', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: health.id,
                    batchId: health.batch_id
                })
            });
        } catch (err) {
            console.error('Failed to close health check dialog and queue batch:', err);
        }
    };

    // Dismiss with Escape key
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape' && showOnDemandAlert) {
                handleCloseHealthCheck();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showOnDemandAlert, stream.integrationHealth?.id, stream.integrationHealth?.batch_id]);

    return (
        <div className="historian-app-container">
            {/* Global BatchLine On-Demand HealthCheck Alert Popup */}
            {showOnDemandAlert && (
                <HealthCheckDialog
                    health={stream.integrationHealth}
                    onDismiss={handleCloseHealthCheck}
                />
            )}

            {/* Global Industrial SCADA Header */}
            <Header
                clock={stream.clock}
                running={stream.running}
                speed={stream.speed}
                connected={stream.connected}
                mode={stream.mode}
                assignedBatchId={stream.assignedBatchId}
                singleBatchStatus={stream.singleBatchStatus}
                integrationHealth={stream.integrationHealth}
                activePage={currentPage}
                onNavigate={handleNavigate}
                pendingScheduledCount={stream.pendingScheduledCount || 0}
            />

            {/* Active View: Process Mimic vs Scheduled Instructions Queue */}
            {currentPage === 'scheduled' ? (
                <ScheduledTasks
                    stream={stream}
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

