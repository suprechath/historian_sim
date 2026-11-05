import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

// Case category descriptors
const EVENT_TYPES = {
    1: { name: 'Case 1: Point-in-Time', short: 'Point-in-Time / Value', color: 'badge-case-1' },
    2: { name: 'Case 2: Phase Timestamp', short: 'Phase Timestamp', color: 'badge-case-2' },
    3: { name: 'Case 3: Profile / Range', short: 'Profile / Range', color: 'badge-case-3' }
};

const TIME_SOURCES = {
    HISTORIAN_EVENT: { label: 'Historian Event', desc: 'Resolved dynamically from DCS phase start/end times' },
    PAYLOAD: { label: 'Webhook Payload', desc: 'Resolved dynamically from upstream instruction payload' },
    STATIC: { label: 'Static Value', desc: 'Fixed predetermined timestamp or direct value' }
};

export default function ConfigurePage({ onNavigate }) {
    // Active configuration tab: 'step' | 'predefined'
    const [activeTab, setActiveTab] = useState('step');

    // Data lists
    const [stepTemplates, setStepTemplates] = useState([]);
    const [predefinedTemplates, setPredefinedTemplates] = useState([]);
    const [meta, setMeta] = useState({ tags: [], phases: [] });
    const [loading, setLoading] = useState(false);

    // Filters & Search
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState('ALL'); // 'ALL' | 'ACTIVE' | 'INACTIVE'
    const [eventTypeFilter, setEventTypeFilter] = useState('ALL'); // 'ALL' | '1' | '2' | '3'

    // Editor Modal state
    const [modalOpen, setModalOpen] = useState(false);
    const [editingType, setEditingType] = useState('step'); // 'step' | 'predefined'
    const [editingItem, setEditingItem] = useState(null); // null = create, object = edit
    const [formData, setFormData] = useState({});
    const [formErrors, setFormErrors] = useState({});
    const [saving, setSaving] = useState(false);

    // Delete Confirmation Modal state
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [itemToDelete, setItemToDelete] = useState(null);
    const [deleting, setDeleting] = useState(false);

    // Toast alert
    const [toast, setToast] = useState(null);

    const editDialogRef = useRef(null);
    const deleteDialogRef = useRef(null);

    const showToast = (message, type = 'success') => {
        setToast({ message, type });
    };

    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(timer);
    }, [toast]);

    // Fetch metadata (available tags and recipe phase names)
    useEffect(() => {
        fetch('/ui/configuration/meta')
            .then(res => res.json())
            .then(data => {
                if (data && !data.error) {
                    setMeta({
                        tags: Array.isArray(data.tags) ? data.tags : [],
                        phases: Array.isArray(data.phases) ? data.phases : []
                    });
                }
            })
            .catch(err => console.error('Failed to fetch configuration metadata:', err));
    }, []);

    // Fetch templates from API
    const fetchTemplates = useCallback(async (isSilent = false) => {
        if (!isSilent) setLoading(true);
        try {
            const [stepRes, preRes] = await Promise.all([
                fetch('/ui/configuration/step-triggered-templates'),
                fetch('/ui/configuration/predefined-templates')
            ]);

            if (stepRes.ok) {
                const stepData = await stepRes.json();
                setStepTemplates(stepData.templates || []);
            }
            if (preRes.ok) {
                const preData = await preRes.json();
                setPredefinedTemplates(preData.templates || []);
            }
        } catch (err) {
            console.error('Error fetching configuration templates:', err);
            showToast('Failed to load templates from server', 'error');
        } finally {
            if (!isSilent) setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchTemplates(false);
    }, [fetchTemplates]);

    // Native modal helper with click-outside fallback per modern web guidance
    useEffect(() => {
        const dialog = editDialogRef.current;
        if (!dialog) return;

        if (modalOpen && !dialog.open) {
            dialog.showModal();
        } else if (!modalOpen && dialog.open) {
            dialog.close();
        }
    }, [modalOpen]);

    useEffect(() => {
        const dialog = deleteDialogRef.current;
        if (!dialog) return;

        if (deleteModalOpen && !dialog.open) {
            dialog.showModal();
        } else if (!deleteModalOpen && dialog.open) {
            dialog.close();
        }
    }, [deleteModalOpen]);

    // Setup fallback light-dismiss for browsers without closedby support
    const handleDialogBackdropClick = (e, onClose) => {
        if (e.target === e.currentTarget) {
            const rect = e.currentTarget.getBoundingClientRect();
            const isInDialog = (
                rect.top <= e.clientY &&
                e.clientY <= rect.top + rect.height &&
                rect.left <= e.clientX &&
                e.clientX <= rect.left + rect.width
            );
            if (!isInDialog) {
                onClose();
            }
        }
    };

    // Filtered lists
    const filteredStepTemplates = useMemo(() => {
        return stepTemplates.filter(t => {
            if (statusFilter === 'ACTIVE' && !t.is_active) return false;
            if (statusFilter === 'INACTIVE' && t.is_active) return false;
            if (eventTypeFilter !== 'ALL' && String(t.event_type) !== eventTypeFilter) return false;
            if (searchQuery.trim()) {
                const q = searchQuery.toLowerCase();
                const matchName = t.name?.toLowerCase().includes(q);
                const matchTrigger = t.trigger_instruction_id?.toLowerCase().includes(q);
                const matchRef = t.ref_instruction?.toLowerCase().includes(q);
                const matchTag = t.ref_element?.toLowerCase().includes(q);
                const matchDesc = t.instruction_description?.toLowerCase().includes(q);
                if (!matchName && !matchTrigger && !matchRef && !matchTag && !matchDesc) return false;
            }
            return true;
        });
    }, [stepTemplates, statusFilter, eventTypeFilter, searchQuery]);

    const filteredPredefinedTemplates = useMemo(() => {
        return predefinedTemplates.filter(t => {
            if (statusFilter === 'ACTIVE' && !t.is_active) return false;
            if (statusFilter === 'INACTIVE' && t.is_active) return false;
            if (eventTypeFilter !== 'ALL' && String(t.event_type) !== eventTypeFilter) return false;
            if (searchQuery.trim()) {
                const q = searchQuery.toLowerCase();
                const matchName = t.name?.toLowerCase().includes(q);
                const matchRef = t.ref_instruction?.toLowerCase().includes(q);
                const matchTag = t.ref_element?.toLowerCase().includes(q);
                const matchDesc = t.instruction_description?.toLowerCase().includes(q);
                const matchEvent = t.ref_event?.toLowerCase().includes(q);
                if (!matchName && !matchRef && !matchTag && !matchDesc && !matchEvent) return false;
            }
            return true;
        });
    }, [predefinedTemplates, statusFilter, eventTypeFilter, searchQuery]);

    // Quick inline active toggle
    const handleToggleActive = async (type, item) => {
        const url = type === 'step'
            ? `/ui/configuration/step-triggered-templates/${item.id}/toggle`
            : `/ui/configuration/predefined-templates/${item.id}/toggle`;

        try {
            const res = await fetch(url, { method: 'PATCH' });
            if (res.ok) {
                const data = await res.json();
                const updated = data.template;
                if (type === 'step') {
                    setStepTemplates(prev => prev.map(t => t.id === updated.id ? updated : t));
                } else {
                    setPredefinedTemplates(prev => prev.map(t => t.id === updated.id ? updated : t));
                }
                showToast(`"${updated.name}" is now ${updated.is_active ? 'ACTIVE' : 'INACTIVE'}`);
            } else {
                const errData = await res.json().catch(() => ({}));
                showToast(`Failed to toggle: ${errData.error || 'Server error'}`, 'error');
            }
        } catch (err) {
            showToast(`Connection error: ${err.message}`, 'error');
        }
    };

    // Open Add / Edit Modal
    const handleOpenEditModal = (type, item = null, isDuplicate = false) => {
        setEditingType(type);
        setEditingItem(isDuplicate ? null : item);
        setFormErrors({});

        if (item) {
            setFormData({
                ...item,
                name: isDuplicate ? `${item.name} (Copy)` : item.name,
                ref_instruction: isDuplicate ? `${item.ref_instruction}_COPY` : item.ref_instruction
            });
        } else {
            // New defaults
            if (type === 'step') {
                setFormData({
                    name: '',
                    trigger_instruction_id: '',
                    time_source: 'HISTORIAN_EVENT',
                    instruction_id: '',
                    instruction_description: '[RECORD]',
                    ref_instruction: '',
                    event_type: 3,
                    ref_event: '',
                    ref_type: 'MAX',
                    ref_element: '',
                    ref_start_event: '',
                    ref_start_type: 'StartTime',
                    ref_end_event: '',
                    ref_end_type: 'EndTime',
                    payload_start_field: 'ActualResult',
                    payload_end_field: '',
                    offset_duration_ms: 0,
                    expected_result: '',
                    is_active: true
                });
            } else {
                setFormData({
                    name: '',
                    instruction_id: '',
                    instruction_description: 'Schedule event fetching [SCHEDULE]',
                    ref_instruction: '',
                    event_type: 2,
                    ref_event: 'Charging',
                    ref_type: 'StartTime',
                    ref_element: '',
                    ref_time: '',
                    ref_start_time: '',
                    ref_end_time: '',
                    expected_result: '',
                    is_active: true
                });
            }
        }
        setModalOpen(true);
    };

    const handleFormChange = (e) => {
        const { name, value, type, checked } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: type === 'checkbox' ? checked : value
        }));
        if (formErrors[name]) {
            setFormErrors(prev => ({ ...prev, [name]: null }));
        }
    };

    // Save Form (Create or Update)
    const handleSaveTemplate = async (e) => {
        e.preventDefault();
        setSaving(true);
        setFormErrors({});

        const errors = {};
        if (!formData.name?.trim()) errors.name = 'Template name is required';
        if (!formData.ref_instruction?.trim()) errors.ref_instruction = 'Target Ref instruction is required';
        if (editingType === 'step' && !formData.trigger_instruction_id?.trim()) {
            errors.trigger_instruction_id = 'Trigger instruction ID is required';
        }

        if (Object.keys(errors).length > 0) {
            setFormErrors(errors);
            setSaving(false);
            return;
        }

        const isEdit = Boolean(editingItem?.id);
        const url = editingType === 'step'
            ? (isEdit ? `/ui/configuration/step-triggered-templates/${editingItem.id}` : '/ui/configuration/step-triggered-templates')
            : (isEdit ? `/ui/configuration/predefined-templates/${editingItem.id}` : '/ui/configuration/predefined-templates');
        const method = isEdit ? 'PUT' : 'POST';

        try {
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            const data = await res.json();
            if (res.ok) {
                showToast(`Template "${formData.name}" successfully ${isEdit ? 'updated' : 'created'}.`);
                setModalOpen(false);
                fetchTemplates(true);
            } else {
                showToast(`Save failed: ${data.error || 'Server error'}`, 'error');
            }
        } catch (err) {
            showToast(`Connection error: ${err.message}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    // Open Delete confirmation
    const handleOpenDelete = (type, item) => {
        setEditingType(type);
        setItemToDelete(item);
        setDeleteModalOpen(true);
    };

    // Execute Delete
    const handleConfirmDelete = async () => {
        if (!itemToDelete) return;
        setDeleting(true);

        const url = editingType === 'step'
            ? `/ui/configuration/step-triggered-templates/${itemToDelete.id}`
            : `/ui/configuration/predefined-templates/${itemToDelete.id}`;

        try {
            const res = await fetch(url, { method: 'DELETE' });
            if (res.ok) {
                showToast(`Deleted template "${itemToDelete.name}".`);
                setDeleteModalOpen(false);
                setItemToDelete(null);
                fetchTemplates(true);
            } else {
                const data = await res.json().catch(() => ({}));
                showToast(`Delete failed: ${data.error || 'Server error'}`, 'error');
            }
        } catch (err) {
            showToast(`Connection error: ${err.message}`, 'error');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <main className="configure-main">
            {/* Header / Navigation Bar */}
            <header className="configure-header">
                <div className="configure-header-left">
                    <button
                        type="button"
                        className="btn-back"
                        onClick={() => onNavigate && onNavigate('overview')}
                        title="Return to Process Mimic overview"
                    >
                        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                            <path fillRule="evenodd" d="M15 8a.5.5 0 0 0-.5-.5H2.707l3.147-3.146a.5.5 0 1 0-.708-.708l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L2.707 8.5H14.5A.5.5 0 0 0 15 8z"/>
                        </svg>
                        <span>Back to Process Mimic</span>
                    </button>
                    <div className="configure-title-group">
                        <h2>Automation & Trigger Configuration</h2>
                        <span className="configure-subtitle">
                            Configure automated batch execution instructions and Layer-2 step-triggered automation triggers
                        </span>
                    </div>
                </div>

                <div className="configure-header-right">
                    <span className="secret-route-badge" title="This page is accessed directly via URL /configure">
                        <span className="secret-dot"></span>
                        URL: /configure
                    </span>
                    <button
                        type="button"
                        className="btn-refresh"
                        onClick={() => fetchTemplates(false)}
                        disabled={loading}
                        title="Refresh configuration data"
                    >
                        <svg className={loading ? 'spin' : ''} viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                            <path fillRule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                            <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
                        </svg>
                        <span>Refresh</span>
                    </button>
                </div>
            </header>

            {/* Tab Selection */}
            <div className="configure-tabs-bar" role="tablist" aria-label="Configuration tables">
                <button
                    type="button"
                    role="tab"
                    id="tab-step-trigger"
                    aria-selected={activeTab === 'step'}
                    aria-controls="panel-step-trigger"
                    className={`configure-tab-btn ${activeTab === 'step' ? 'active' : ''}`}
                    onClick={() => setActiveTab('step')}
                >
                    <span className="tab-title">Step-Triggered Templates</span>
                    <span className="tab-meta-badge">step_triggered_instruction_templates</span>
                    <span className="tab-count-pill">{stepTemplates.length}</span>
                </button>

                <button
                    type="button"
                    role="tab"
                    id="tab-predefined"
                    aria-selected={activeTab === 'predefined'}
                    aria-controls="panel-predefined"
                    className={`configure-tab-btn ${activeTab === 'predefined' ? 'active' : ''}`}
                    onClick={() => setActiveTab('predefined')}
                >
                    <span className="tab-title">Predefined Batch Templates</span>
                    <span className="tab-meta-badge">predefined_instruction_templates</span>
                    <span className="tab-count-pill">{predefinedTemplates.length}</span>
                </button>
            </div>

            {/* Toolbar: Search, Filters & Add Button */}
            <div className="configure-toolbar">
                <div className="toolbar-search-box">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                    </svg>
                    <input
                        type="search"
                        placeholder={activeTab === 'step' ? 'Search by trigger, ref, tag, or name...' : 'Search by ref, event, tag, or name...'}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        aria-label="Filter templates"
                    />
                    {searchQuery && (
                        <button type="button" className="btn-clear-search" onClick={() => setSearchQuery('')}>✕</button>
                    )}
                </div>

                <div className="toolbar-filters">
                    <div className="filter-group">
                        <label htmlFor="filter-status">Status:</label>
                        <select
                            id="filter-status"
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                        >
                            <option value="ALL">All Status</option>
                            <option value="ACTIVE">Active Only</option>
                            <option value="INACTIVE">Inactive Only</option>
                        </select>
                    </div>

                    <div className="filter-group">
                        <label htmlFor="filter-event-type">Case Category:</label>
                        <select
                            id="filter-event-type"
                            value={eventTypeFilter}
                            onChange={(e) => setEventTypeFilter(e.target.value)}
                        >
                            <option value="ALL">All Cases (1, 2, 3)</option>
                            <option value="1">Case 1 (Point-in-Time / PrevBatch)</option>
                            <option value="2">Case 2 (Phase Timestamp)</option>
                            <option value="3">Case 3 (Profile / Time Range)</option>
                        </select>
                    </div>

                    <button
                        type="button"
                        className="btn-add-template"
                        onClick={() => handleOpenEditModal(activeTab, null)}
                    >
                        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                            <path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z"/>
                        </svg>
                        <span>Add {activeTab === 'step' ? 'Step Trigger' : 'Predefined Template'}</span>
                    </button>
                </div>
            </div>

            {/* TAB 1: Step-Triggered Templates Table */}
            {activeTab === 'step' && (
                <div
                    id="panel-step-trigger"
                    role="tabpanel"
                    aria-labelledby="tab-step-trigger"
                    className="configure-table-container"
                >
                    <div className="table-caption-bar">
                        <span className="caption-title">Layer-2 On-Demand Execution Schedulers</span>
                        <span className="caption-desc">Fired automatically upon completion of upstream BatchLine instructions</span>
                    </div>

                    <div tabIndex="0" role="region" aria-label="Step triggered instruction templates" className="table-wrapper">
                        <table className="configure-data-table">
                            <thead>
                                <tr>
                                    <th style={{ width: '80px' }}>Active</th>
                                    <th style={{ width: '130px' }}>Trigger ID</th>
                                    <th style={{ width: '120px' }}>Target Ref</th>
                                    <th>Template Name & Directives</th>
                                    <th style={{ width: '150px' }}>Category</th>
                                    <th style={{ width: '170px' }}>Time Sourcing</th>
                                    <th style={{ width: '130px' }}>Tag / Element</th>
                                    <th style={{ width: '120px', textAlign: 'center' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredStepTemplates.length === 0 ? (
                                    <tr>
                                        <td colSpan="8" className="empty-table-cell">
                                            No step-triggered templates found matching your search.
                                        </td>
                                    </tr>
                                ) : (
                                    filteredStepTemplates.map(item => (
                                        <tr key={item.id} className={item.is_active ? 'row-active' : 'row-inactive'}>
                                            {/* Active Switch */}
                                            <td>
                                                <button
                                                    type="button"
                                                    role="switch"
                                                    aria-checked={item.is_active}
                                                    className={`toggle-switch-btn ${item.is_active ? 'on' : 'off'}`}
                                                    onClick={() => handleToggleActive('step', item)}
                                                    title={item.is_active ? 'Click to deactivate' : 'Click to activate'}
                                                >
                                                    <span className="toggle-switch-thumb"></span>
                                                </button>
                                            </td>

                                            {/* Trigger Instruction ID */}
                                            <td>
                                                <span className="pill-trigger mono" title={`Fired by instruction ${item.trigger_instruction_id}`}>
                                                    {item.trigger_instruction_id}
                                                </span>
                                            </td>

                                            {/* Target Ref Instruction */}
                                            <td>
                                                <span className="pill-ref mono" title={`Target instruction ${item.ref_instruction}`}>
                                                    {item.ref_instruction}
                                                </span>
                                            </td>

                                            {/* Name & Directives */}
                                            <td>
                                                <div className="template-name-box">
                                                    <strong className="template-title">{item.name}</strong>
                                                    <span className="template-desc-tag mono">
                                                        {item.instruction_description}
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Event Type / Case */}
                                            <td>
                                                <span className={`pill-case ${EVENT_TYPES[item.event_type]?.color || 'badge-case-default'}`}>
                                                    {EVENT_TYPES[item.event_type]?.short || `Case ${item.event_type}`}
                                                </span>
                                            </td>

                                            {/* Time Sourcing */}
                                            <td>
                                                <div className="sourcing-box">
                                                    <span className="source-tag">{item.time_source}</span>
                                                    {item.time_source === 'HISTORIAN_EVENT' && item.ref_start_event && (
                                                        <small className="source-detail">
                                                            {item.ref_start_event} ({item.ref_start_type})
                                                            {item.ref_end_event && ` → ${item.ref_end_event} (${item.ref_end_type})`}
                                                        </small>
                                                    )}
                                                    {item.time_source === 'PAYLOAD' && (
                                                        <small className="source-detail">
                                                            Field: {item.payload_start_field || 'ActualResult'}
                                                            {item.offset_duration_ms > 0 && ` (+${item.offset_duration_ms / 1000}s)`}
                                                        </small>
                                                    )}
                                                </div>
                                            </td>

                                            {/* Sensor Tag */}
                                            <td>
                                                {item.ref_element ? (
                                                    <span className="pill-tag mono">{item.ref_element}</span>
                                                ) : (
                                                    <span className="text-muted">—</span>
                                                )}
                                            </td>

                                            {/* Actions */}
                                            <td style={{ textAlign: 'center' }}>
                                                <div className="action-buttons-group">
                                                    <button
                                                        type="button"
                                                        className="btn-action edit"
                                                        onClick={() => handleOpenEditModal('step', item)}
                                                        title="Edit template"
                                                    >
                                                        ✎
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="btn-action duplicate"
                                                        onClick={() => handleOpenEditModal('step', item, true)}
                                                        title="Duplicate template"
                                                    >
                                                        ⎘
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="btn-action delete"
                                                        onClick={() => handleOpenDelete('step', item)}
                                                        title="Delete template"
                                                    >
                                                        🗑
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* TAB 2: Predefined Templates Table */}
            {activeTab === 'predefined' && (
                <div
                    id="panel-predefined"
                    role="tabpanel"
                    aria-labelledby="tab-predefined"
                    className="configure-table-container"
                >
                    <div className="table-caption-bar">
                        <span className="caption-title">Layer-1 Base Batch Templates</span>
                        <span className="caption-desc">Automatically dispatched when a new batch starts or health check closes</span>
                    </div>

                    <div tabIndex="0" role="region" aria-label="Predefined instruction templates" className="table-wrapper">
                        <table className="configure-data-table">
                            <thead>
                                <tr>
                                    <th style={{ width: '80px' }}>Active</th>
                                    <th style={{ width: '120px' }}>Target Ref</th>
                                    <th>Template Name & Directives</th>
                                    <th style={{ width: '150px' }}>Category</th>
                                    <th style={{ width: '160px' }}>Event & Type</th>
                                    <th style={{ width: '130px' }}>Tag / Element</th>
                                    <th style={{ width: '120px', textAlign: 'center' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredPredefinedTemplates.length === 0 ? (
                                    <tr>
                                        <td colSpan="7" className="empty-table-cell">
                                            No predefined templates found matching your search.
                                        </td>
                                    </tr>
                                ) : (
                                    filteredPredefinedTemplates.map(item => (
                                        <tr key={item.id} className={item.is_active ? 'row-active' : 'row-inactive'}>
                                            {/* Active Switch */}
                                            <td>
                                                <button
                                                    type="button"
                                                    role="switch"
                                                    aria-checked={item.is_active}
                                                    className={`toggle-switch-btn ${item.is_active ? 'on' : 'off'}`}
                                                    onClick={() => handleToggleActive('predefined', item)}
                                                    title={item.is_active ? 'Click to deactivate' : 'Click to activate'}
                                                >
                                                    <span className="toggle-switch-thumb"></span>
                                                </button>
                                            </td>

                                            {/* Target Ref */}
                                            <td>
                                                <span className="pill-ref mono">{item.ref_instruction}</span>
                                            </td>

                                            {/* Name & Directives */}
                                            <td>
                                                <div className="template-name-box">
                                                    <strong className="template-title">{item.name}</strong>
                                                    <span className="template-desc-tag mono">
                                                        {item.instruction_description}
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Category */}
                                            <td>
                                                <span className={`pill-case ${EVENT_TYPES[item.event_type]?.color || 'badge-case-default'}`}>
                                                    {EVENT_TYPES[item.event_type]?.short || `Case ${item.event_type}`}
                                                </span>
                                            </td>

                                            {/* Event & Type */}
                                            <td>
                                                <div className="event-detail-box">
                                                    <strong>{item.ref_event || '—'}</strong>
                                                    {item.ref_type && <small className="text-muted">Type: {item.ref_type}</small>}
                                                </div>
                                            </td>

                                            {/* Sensor Tag */}
                                            <td>
                                                {item.ref_element ? (
                                                    <span className="pill-tag mono">{item.ref_element}</span>
                                                ) : (
                                                    <span className="text-muted">—</span>
                                                )}
                                            </td>

                                            {/* Actions */}
                                            <td style={{ textAlign: 'center' }}>
                                                <div className="action-buttons-group">
                                                    <button
                                                        type="button"
                                                        className="btn-action edit"
                                                        onClick={() => handleOpenEditModal('predefined', item)}
                                                        title="Edit template"
                                                    >
                                                        ✎
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="btn-action duplicate"
                                                        onClick={() => handleOpenEditModal('predefined', item, true)}
                                                        title="Duplicate template"
                                                    >
                                                        ⎘
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="btn-action delete"
                                                        onClick={() => handleOpenDelete('predefined', item)}
                                                        title="Delete template"
                                                    >
                                                        🗑
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Modal Dialog: Add / Edit Template */}
            <dialog
                ref={editDialogRef}
                closedby="any"
                aria-labelledby="dialog-template-title"
                className="configure-modal-dialog"
                onClick={(e) => handleDialogBackdropClick(e, () => setModalOpen(false))}
            >
                <div className="modal-dialog-content">
                    <div className="modal-dialog-header">
                        <h3 id="dialog-template-title">
                            {editingItem?.id ? 'Edit Template' : 'Add New Template'}
                            <small className="modal-type-indicator">
                                ({editingType === 'step' ? 'step_triggered_instruction_templates' : 'predefined_instruction_templates'})
                            </small>
                        </h3>
                        <button
                            type="button"
                            className="btn-modal-close"
                            onClick={() => setModalOpen(false)}
                            aria-label="Close dialog"
                        >
                            ✕
                        </button>
                    </div>

                    <form onSubmit={handleSaveTemplate} className="modal-dialog-form">
                        {/* 1. General Info */}
                        <fieldset className="form-section">
                            <legend>Basic Information</legend>
                            <div className="form-row-2">
                                <div className="form-field">
                                    <label htmlFor="tpl-name">
                                        Template Name <span className="req">*</span>
                                    </label>
                                    <input
                                        id="tpl-name"
                                        name="name"
                                        type="text"
                                        required
                                        placeholder="e.g. Pressure curves of filter"
                                        value={formData.name || ''}
                                        onChange={handleFormChange}
                                    />
                                    {formErrors.name && <span className="field-error">{formErrors.name}</span>}
                                </div>

                                <div className="form-field field-checkbox-wrap">
                                    <label className="checkbox-label" htmlFor="tpl-active">
                                        <input
                                            id="tpl-active"
                                            name="is_active"
                                            type="checkbox"
                                            checked={Boolean(formData.is_active)}
                                            onChange={handleFormChange}
                                        />
                                        <span>Active & Enabled for Evaluation</span>
                                    </label>
                                    <small className="field-hint">If disabled, triggers matching this template will be skipped.</small>
                                </div>
                            </div>
                        </fieldset>

                        {/* 2. Trigger Configuration (Step-Triggered Only) */}
                        {editingType === 'step' && (
                            <fieldset className="form-section">
                                <legend>Trigger & Timing Source</legend>
                                <div className="form-row-2">
                                    <div className="form-field">
                                        <label htmlFor="tpl-trigger-id">
                                            Trigger Instruction ID / Ref <span className="req">*</span>
                                        </label>
                                        <input
                                            id="tpl-trigger-id"
                                            name="trigger_instruction_id"
                                            type="text"
                                            required
                                            placeholder="e.g. CGET, HTST, REET, 130T"
                                            value={formData.trigger_instruction_id || ''}
                                            onChange={handleFormChange}
                                        />
                                        <small className="field-hint">BatchLine instruction code that fires this trigger upon completion.</small>
                                        {formErrors.trigger_instruction_id && (
                                            <span className="field-error">{formErrors.trigger_instruction_id}</span>
                                        )}
                                    </div>

                                    <div className="form-field">
                                        <label htmlFor="tpl-time-source">Time Sourcing Mode</label>
                                        <select
                                            id="tpl-time-source"
                                            name="time_source"
                                            value={formData.time_source || 'HISTORIAN_EVENT'}
                                            onChange={handleFormChange}
                                        >
                                            <option value="HISTORIAN_EVENT">HISTORIAN_EVENT (Resolved from DCS events table)</option>
                                            <option value="PAYLOAD">PAYLOAD (Resolved from incoming webhook ActualResult)</option>
                                            <option value="STATIC">STATIC (Fixed timestamp / Immediate)</option>
                                        </select>
                                        <small className="field-hint">
                                            {TIME_SOURCES[formData.time_source]?.desc || ''}
                                        </small>
                                    </div>
                                </div>
                            </fieldset>
                        )}

                        {/* 3. Target Instruction Details */}
                        <fieldset className="form-section">
                            <legend>Target Instruction Specification</legend>
                            <div className="form-row-3">
                                <div className="form-field">
                                    <label htmlFor="tpl-ref-instruction">
                                        Target Ref Instruction <span className="req">*</span>
                                    </label>
                                    <input
                                        id="tpl-ref-instruction"
                                        name="ref_instruction"
                                        type="text"
                                        required
                                        placeholder="e.g. PRESS, RECTEMP, 130T"
                                        value={formData.ref_instruction || ''}
                                        onChange={handleFormChange}
                                    />
                                    <small className="field-hint">Target instruction code updated in BatchLine.</small>
                                    {formErrors.ref_instruction && (
                                        <span className="field-error">{formErrors.ref_instruction}</span>
                                    )}
                                </div>

                                <div className="form-field">
                                    <label htmlFor="tpl-instruction-id">Instruction ID</label>
                                    <input
                                        id="tpl-instruction-id"
                                        name="instruction_id"
                                        type="text"
                                        placeholder="Defaults to ref_instruction"
                                        value={formData.instruction_id || ''}
                                        onChange={handleFormChange}
                                    />
                                </div>

                                <div className="form-field">
                                    <label htmlFor="tpl-event-type">Case Category</label>
                                    <select
                                        id="tpl-event-type"
                                        name="event_type"
                                        value={formData.event_type || 1}
                                        onChange={handleFormChange}
                                    >
                                        <option value={1}>Case 1: Point-in-time / Value / PrevBatch</option>
                                        <option value={2}>Case 2: Phase Timestamp (StartTime / EndTime)</option>
                                        <option value={3}>Case 3: Profile / Time Range / Min / Max</option>
                                    </select>
                                </div>
                            </div>

                            <div className="form-field">
                                <label htmlFor="tpl-desc">
                                    Instruction Description & Directives <span className="req">*</span>
                                </label>
                                <input
                                    id="tpl-desc"
                                    name="instruction_description"
                                    type="text"
                                    required
                                    placeholder="e.g. [RECORD], [TIME: VALUE=130], [PREVBATCH], [SCHEDULE]"
                                    value={formData.instruction_description || ''}
                                    onChange={handleFormChange}
                                />
                                <small className="field-hint">
                                    Directives include: <code>[RECORD]</code> (continuous profile), <code>[RECORD: START=140, STOP=140]</code> (wave rise), <code>[TIME: VALUE=130]</code> (crossing point), <code>[PREVBATCH]</code> (previous batch), <code>[INTERPRET: 1="Yes", 0="No"]</code>
                                </small>
                            </div>
                        </fieldset>

                        {/* 4. Timing & Dynamic Resolution Details */}
                        {editingType === 'step' && formData.time_source === 'HISTORIAN_EVENT' && (
                            <fieldset className="form-section">
                                <legend>Historian Event Resolution (DCS Phase Times)</legend>
                                <div className="form-row-2">
                                    <div className="form-field">
                                        <label htmlFor="tpl-start-event">Start Phase Name</label>
                                        <input
                                            id="tpl-start-event"
                                            name="ref_start_event"
                                            type="text"
                                            list="phases-list"
                                            placeholder="e.g. Charging, Heating, Cooling"
                                            value={formData.ref_start_event || ''}
                                            onChange={handleFormChange}
                                        />
                                    </div>
                                    <div className="form-field">
                                        <label htmlFor="tpl-start-type">Start Timestamp Type</label>
                                        <select
                                            id="tpl-start-type"
                                            name="ref_start_type"
                                            value={formData.ref_start_type || 'StartTime'}
                                            onChange={handleFormChange}
                                        >
                                            <option value="StartTime">StartTime (started_at)</option>
                                            <option value="EndTime">EndTime (ended_at)</option>
                                        </select>
                                    </div>
                                </div>

                                <div className="form-row-2">
                                    <div className="form-field">
                                        <label htmlFor="tpl-end-event">End Phase Name (Optional)</label>
                                        <input
                                            id="tpl-end-event"
                                            name="ref_end_event"
                                            type="text"
                                            list="phases-list"
                                            placeholder="Defaults to Start Phase if empty"
                                            value={formData.ref_end_event || ''}
                                            onChange={handleFormChange}
                                        />
                                    </div>
                                    <div className="form-field">
                                        <label htmlFor="tpl-end-type">End Timestamp Type</label>
                                        <select
                                            id="tpl-end-type"
                                            name="ref_end_type"
                                            value={formData.ref_end_type || ''}
                                            onChange={handleFormChange}
                                        >
                                            <option value="">None / Open-ended</option>
                                            <option value="StartTime">StartTime (started_at)</option>
                                            <option value="EndTime">EndTime (ended_at)</option>
                                        </select>
                                    </div>
                                </div>
                            </fieldset>
                        )}

                        {editingType === 'step' && formData.time_source === 'PAYLOAD' && (
                            <fieldset className="form-section">
                                <legend>Webhook Payload Resolution</legend>
                                <div className="form-row-3">
                                    <div className="form-field">
                                        <label htmlFor="tpl-payload-start">Payload Start Field</label>
                                        <input
                                            id="tpl-payload-start"
                                            name="payload_start_field"
                                            type="text"
                                            placeholder="ActualResult"
                                            value={formData.payload_start_field || 'ActualResult'}
                                            onChange={handleFormChange}
                                        />
                                        <small className="field-hint">e.g. ActualResult, ExecutedTimestamp</small>
                                    </div>
                                    <div className="form-field">
                                        <label htmlFor="tpl-payload-end">Payload End Field (Optional)</label>
                                        <input
                                            id="tpl-payload-end"
                                            name="payload_end_field"
                                            type="text"
                                            placeholder="e.g. RefEndTime"
                                            value={formData.payload_end_field || ''}
                                            onChange={handleFormChange}
                                        />
                                    </div>
                                    <div className="form-field">
                                        <label htmlFor="tpl-offset-ms">Offset Duration (ms)</label>
                                        <input
                                            id="tpl-offset-ms"
                                            name="offset_duration_ms"
                                            type="number"
                                            placeholder="0"
                                            value={formData.offset_duration_ms || 0}
                                            onChange={handleFormChange}
                                        />
                                        <small className="field-hint">e.g. 180000 for +3 mins</small>
                                    </div>
                                </div>
                            </fieldset>
                        )}

                        {editingType === 'predefined' && (
                            <fieldset className="form-section">
                                <legend>Phase & Timestamp Resolution</legend>
                                <div className="form-row-2">
                                    <div className="form-field">
                                        <label htmlFor="tpl-pre-event">Phase Event Name</label>
                                        <input
                                            id="tpl-pre-event"
                                            name="ref_event"
                                            type="text"
                                            list="phases-list"
                                            placeholder="e.g. Charging, Heating, Reaction hold"
                                            value={formData.ref_event || ''}
                                            onChange={handleFormChange}
                                        />
                                    </div>
                                    <div className="form-field">
                                        <label htmlFor="tpl-pre-type">Timestamp / Aggregate Type</label>
                                        <select
                                            id="tpl-pre-type"
                                            name="ref_type"
                                            value={formData.ref_type || 'StartTime'}
                                            onChange={handleFormChange}
                                        >
                                            <option value="StartTime">StartTime</option>
                                            <option value="EndTime">EndTime</option>
                                            <option value="MAX">MAX</option>
                                            <option value="MIN">MIN</option>
                                            <option value="AVG">AVG</option>
                                            <option value="PROFILE">PROFILE</option>
                                        </select>
                                    </div>
                                </div>
                            </fieldset>
                        )}

                        {/* 5. Sensor Tag & Expected Result */}
                        <fieldset className="form-section">
                            <legend>Sensor Tag & Setpoint</legend>
                            <div className="form-row-2">
                                <div className="form-field">
                                    <label htmlFor="tpl-tag">Historian Sensor Tag (RefElement)</label>
                                    <input
                                        id="tpl-tag"
                                        name="ref_element"
                                        type="text"
                                        list="tags-list"
                                        placeholder="e.g. R1.TEMP, R1.FILTER_DP, R1.PRES"
                                        value={formData.ref_element || ''}
                                        onChange={handleFormChange}
                                    />
                                    <small className="field-hint">Select from plant sensor list or enter tag name.</small>
                                </div>

                                <div className="form-field">
                                    <label htmlFor="tpl-expected">Expected Result / Setpoint (Optional)</label>
                                    <input
                                        id="tpl-expected"
                                        name="expected_result"
                                        type="text"
                                        placeholder="e.g. 140, Yes, criteria"
                                        value={formData.expected_result || ''}
                                        onChange={handleFormChange}
                                    />
                                </div>
                            </div>
                        </fieldset>

                        {/* Datalists for Autocomplete */}
                        <datalist id="phases-list">
                            {meta.phases.map(p => (
                                <option key={p} value={p} />
                            ))}
                        </datalist>

                        <datalist id="tags-list">
                            {meta.tags.map(t => (
                                <option key={t.name} value={t.name}>
                                    {t.parameter} ({t.asset_code})
                                </option>
                            ))}
                        </datalist>

                        {/* Actions */}
                        <div className="modal-dialog-footer">
                            <button
                                type="button"
                                className="btn-cancel"
                                onClick={() => setModalOpen(false)}
                                disabled={saving}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="btn-save"
                                disabled={saving}
                            >
                                {saving ? 'Saving...' : (editingItem?.id ? 'Save Changes' : 'Create Template')}
                            </button>
                        </div>
                    </form>
                </div>
            </dialog>

            {/* Modal Dialog: Confirm Delete */}
            <dialog
                ref={deleteDialogRef}
                closedby="any"
                aria-labelledby="dialog-delete-title"
                className="configure-modal-dialog delete-confirm-dialog"
                onClick={(e) => handleDialogBackdropClick(e, () => setDeleteModalOpen(false))}
            >
                <div className="modal-dialog-content">
                    <div className="modal-dialog-header">
                        <h3 id="dialog-delete-title">Confirm Deletion</h3>
                        <button
                            type="button"
                            className="btn-modal-close"
                            onClick={() => setDeleteModalOpen(false)}
                            aria-label="Close dialog"
                        >
                            ✕
                        </button>
                    </div>

                    <div className="modal-dialog-body">
                        <p>
                            Are you sure you want to permanently delete template{' '}
                            <strong>"{itemToDelete?.name}"</strong> (Target Ref:{' '}
                            <code>{itemToDelete?.ref_instruction}</code>)?
                        </p>
                        <p className="delete-warning-text">
                            This template will no longer be evaluated for future automated batch dispatches or triggers.
                        </p>
                    </div>

                    <div className="modal-dialog-footer">
                        <button
                            type="button"
                            className="btn-cancel"
                            onClick={() => setDeleteModalOpen(false)}
                            disabled={deleting}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="btn-delete-confirm"
                            onClick={handleConfirmDelete}
                            disabled={deleting}
                        >
                            {deleting ? 'Deleting...' : 'Delete Template'}
                        </button>
                    </div>
                </div>
            </dialog>

            {/* Toast Notification */}
            {toast && (
                <div className={`configure-toast ${toast.type}`}>
                    <span className="toast-dot"></span>
                    <span className="toast-message">{toast.message}</span>
                </div>
            )}
        </main>
    );
}
