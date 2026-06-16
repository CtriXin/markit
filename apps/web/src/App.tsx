import { FormEvent, PointerEvent, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type Dispatch, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject, type SetStateAction, type SyntheticEvent as ReactSyntheticEvent, type WheelEvent as ReactWheelEvent } from 'react';

type HealthState = { kind: 'loading' } | { kind: 'ok'; version: string } | { kind: 'error'; message: string };
type View = 'home' | 'session' | 'bugs' | 'settings';
type Tool = 'browse' | 'pointer' | 'pin' | 'rect' | 'ellipse' | 'freehand' | 'element' | 'section';
type DeviceKey = 'pc' | 'mobile';
type ZoomMode = 'fit' | 'manual';
type PreviewMode = 'single' | 'dual';
type Viewport = { name: string; width: number; height: number; deviceScaleFactor: number; isMobile?: boolean };
type Session = { id: string; sourceUrl: string; currentUrl: string; title: string; viewport: Viewport; sessionVersion: number; createdAt?: string };
type Capture = { id: string; sessionId: string; finalUrl: string; title: string; imageSize: { width: number; height: number }; viewport: Viewport; sessionVersion: number; scroll: { x: number; y: number }; mode: string; createdAt: string };
type DeviceSlot = { session: Session; capture?: Capture; captures: Capture[] };
type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type DomTarget = { id: string; selector: string; selectorKind: string; selectorScore: number; label: string; tagName: string; text: string; value?: string; htmlHint: string; captureRect: Rect };
type Annotation = { id: string; captureId: string; kind: string; geometry: { captureRect: Rect; paths?: Point[][] }; target?: DomTarget; note: string; colorRole: string; sortOrder?: number };
type BugReference = { kind: 'requirement' | 'design' | 'compare' | 'other'; url: string; label?: string };
type BugAsset = { id: string; bugId: string; kind: string; fileName: string; mimeType: string; sizeBytes: number; label?: string; createdAt: string };
type DraftAsset = { id: string; kind: 'pasted-screenshot' | 'uploaded-screenshot'; fileName: string; mimeType: string; sizeBytes: number; dataUrl: string; label: string };
type QuickComment = { annotationId: string; captureId: string; rect: Rect; text: string };
type Bug = { id: string; sessionId: string; title: string; actual: string; expected: string; severity: string; status: string; sourceUrl: string; finalUrl: string; primaryCaptureId?: string; tags: string[]; references: BugReference[]; annotationCount?: number; assetCount?: number; exportPath?: string; createdAt?: string; updatedAt?: string };
type BugDetail = { bug: Bug; annotations: Annotation[]; captures: Capture[]; assets: BugAsset[] };
type AiStatus = { enabled: boolean; provider: string; supportsImages?: boolean; configSource?: string; reason?: string };

type DraftBug = { title: string; actual: string; expected: string; severity: string; status: string; comment: string; bugType: string; requirementUrl: string; designUrl: string };

const viewportOptions: Array<Viewport & { key: string }> = [
  { key: 'desktop-1440', name: '桌面端 1440x900', width: 1440, height: 900, deviceScaleFactor: 1 },
  { key: 'laptop-1366', name: '笔记本 1366x768', width: 1366, height: 768, deviceScaleFactor: 1 },
  { key: 'tablet-820', name: '平板 820x1180', width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true },
  { key: 'mobile-430', name: '移动端 430x932', width: 430, height: 932, deviceScaleFactor: 3, isMobile: true },
  { key: 'mobile-390', name: '移动端 390x844', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
  { key: 'mobile-360', name: '移动端 360x800', width: 360, height: 800, deviceScaleFactor: 3, isMobile: true }
];

const emptyDraft: DraftBug = { title: '', actual: '', expected: '', severity: 'P2', status: 'draft', comment: '', bugType: 'layout', requirementUrl: '', designUrl: '' };
const toolLabels: Record<Tool, string> = { browse: '浏览', pointer: '指针', pin: '标记', rect: '框选', ellipse: '圈选', freehand: '自由画', element: '元素', section: '区块' };
const statusLabels: Record<string, string> = { draft: '草稿', open: '待处理', resolved: '已解决', wontfix: '不处理' };
const statusOptions = [
  { value: 'draft', label: '草稿' },
  { value: 'open', label: '待处理' },
  { value: 'resolved', label: '已解决' },
  { value: 'wontfix', label: '不处理' }
];
const annotationKindLabels: Record<string, string> = { browse: '浏览', pointer: '指针', pin: '标记', rect: '框选', ellipse: '圈选', freehand: '自由画', element: '元素', section: '区块' };
const primaryTools: Tool[] = ['browse', 'pointer', 'pin'];
const regionTools: Tool[] = ['rect', 'ellipse', 'freehand'];
const semanticTools: Tool[] = ['element', 'section'];
const bugTypeOptions = [
  { value: 'layout', label: '布局错位', expected: '页面布局应与设计一致，元素完整可见且不遮挡。' },
  { value: 'visual', label: '样式不符', expected: '颜色、字号、间距、圆角、阴影等视觉样式应与设计稿一致。' },
  { value: 'interaction', label: '点击无效', expected: '目标区域应可点击，并按预期跳转或触发交互。' },
  { value: 'copy', label: '文案错误', expected: '页面文案应使用正确语言、大小写和业务描述。' },
  { value: 'responsive', label: '响应式问题', expected: 'PC 和 Mobile 下内容都应完整展示且可正常操作。' },
  { value: 'data', label: '数据错误', expected: '页面数据应与需求或接口返回一致。' },
  { value: 'ad', label: '广告异常', expected: '广告位应按需求展示，不遮挡内容，不缺失关键广告位。' }
] as const;
const deviceOrder: DeviceKey[] = ['pc', 'mobile'];
const assetMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];
const deviceLabels: Record<DeviceKey, { title: string; short: string; hint: string }> = {
  pc: { title: 'PC 模拟', short: 'PC', hint: '桌面端真实截图' },
  mobile: { title: 'Mobile 模拟', short: 'Mobile', hint: '移动端真实截图' }
};
const desktopViewport = viewportOptions[0]!;
const fallbackMobileViewport = viewportOptions.find((viewport) => viewport.key === 'mobile-390') ?? viewportOptions[4]!;

function captureModeLabel(mode: string): string {
  return mode === 'fullPage' ? '整页截图' : '视口截图';
}

export function App() {
  const [view, setView] = useState<View>('home');
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  const [url, setUrl] = useState('');
  const [viewportKey, setViewportKey] = useState('desktop-1440');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session>();
  const [capture, setCapture] = useState<Capture>();
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [domTargets, setDomTargets] = useState<DomTarget[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>([]);
  const [bugs, setBugs] = useState<Bug[]>([]);
  const [selectedBugId, setSelectedBugId] = useState('');
  const [bugDetail, setBugDetail] = useState<BugDetail>();
  const [draft, setDraft] = useState<DraftBug>(emptyDraft);
  const [draftAssets, setDraftAssets] = useState<DraftAsset[]>([]);
  const [quickComment, setQuickComment] = useState<QuickComment>();
  const [tool, setToolState] = useState<Tool>('browse');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [actionText, setActionText] = useState('');
  const [addressText, setAddressText] = useState('');
  const [lastPoint, setLastPoint] = useState<Point>();
  const [dragStart, setDragStart] = useState<Point>();
  const [rectPreview, setRectPreview] = useState<Rect>();
  const dragStartRef = useRef<Point | undefined>(undefined);
  const rectPointerDownRef = useRef<Point | undefined>(undefined);
  const [freehand, setFreehand] = useState<Point[]>([]);
  const freehandRef = useRef<Point[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ enabled: false, provider: 'off' });
  const [deviceSlots, setDeviceSlots] = useState<Partial<Record<DeviceKey, DeviceSlot>>>({});
  const [activeDevice, setActiveDevice] = useState<DeviceKey>('pc');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('single');
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit');
  const [zoomPercent, setZoomPercent] = useState(100);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const lastAnnotationIdRef = useRef<string>('');
  const pendingAnnotationRef = useRef<Promise<void> | undefined>(undefined);
  const wheelDeltaRef = useRef<Point>({ x: 0, y: 0 });
  const wheelTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((body) => setHealth({ kind: 'ok', version: body.version })).catch((error) => setHealth({ kind: 'error', message: String(error) }));
    void refreshSessions();
    void refreshBugs();
    fetch('/api/ai/status').then((r) => r.json()).then(setAiStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!capture) return;
    void loadCaptureSideData(capture.id);
  }, [capture?.id]);

  useEffect(() => {
    if (capture?.finalUrl) setAddressText(capture.finalUrl);
  }, [capture?.finalUrl]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [view]);

  useEffect(() => () => {
    if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
  }, []);

  useEffect(() => {
    if (view !== 'session') return;
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => assetMimeTypes.includes(file.type));
      if (!files.length) return;
      event.preventDefault();
      void addDraftAssetFiles(files, 'pasted-screenshot');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [view]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (view !== 'session') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (target?.closest('[data-live-canvas="true"]') && tool === 'browse') return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveBug();
        return;
      }
      const key = event.key.toLowerCase();
      const nextTool: Partial<Record<string, Tool>> = { b: 'browse', v: 'pointer', p: 'pin', r: 'rect', o: 'ellipse', d: 'freehand', e: 'element', s: 'section' };
      if (nextTool[key]) {
        event.preventDefault();
        setTool(nextTool[key]!);
      } else if (key === 'c') {
        event.preventDefault();
        void createCapture('viewport');
      } else if (key === 'a') {
        event.preventDefault();
        void saveBug();
      } else if (key === 'z') {
        event.preventDefault();
        void undoLastAnnotation();
      } else if (key === 'f') {
        event.preventDefault();
        setZoomMode('fit');
      } else if (/^[1-4]$/.test(key)) {
        event.preventDefault();
        setDraft((current) => ({ ...current, severity: `P${Number(key) - 1}` }));
      } else if (event.key === 'Escape') {
        cancelDrawing();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view, session?.id, capture?.id, draft, selectedAnnotationIds, annotations, tool]);

  function setTool(name: Tool) {
    cancelDrawing();
    setToolState(name);
  }

  function cancelDrawing() {
    dragStartRef.current = undefined;
    rectPointerDownRef.current = undefined;
    freehandRef.current = [];
    setDragStart(undefined);
    setRectPreview(undefined);
    setFreehand([]);
  }

  function closeQuickComment() {
    setQuickComment(undefined);
    cancelDrawing();
  }

  async function createSession(event: FormEvent) {
    event.preventDefault();
    const selectedViewport = viewportOptions.find((item) => item.key === viewportKey) ?? fallbackMobileViewport;
    const selectedDevice = deviceForViewport(selectedViewport);
    setBusy(`正在打开${deviceLabels[selectedDevice].title}`);
    setMessage('');
    try {
      const slot = await createDeviceSlot(selectedDevice, url, selectedViewport);
      const nextSlots: Partial<Record<DeviceKey, DeviceSlot>> = { [selectedDevice]: slot };
      setDeviceSlots(nextSlots);
      setActiveDevice(selectedDevice);
      setSession(slot.session);
      setCapture(slot.capture);
      setCaptures(slot.captures);
      setPreviewMode('single');
      setZoomMode('fit');
      setDraft(emptyDraft);
      setDraftAssets([]);
      setQuickComment(undefined);
      setTool('browse');
      setView('session');
      await Promise.all([refreshSessions(), refreshBugs()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建会话失败');
    } finally {
      setBusy('');
    }
  }

  async function openExistingSession(nextSession: Session) {
    setBusy('正在打开已保存会话');
    setMessage('');
    try {
      const device: DeviceKey = nextSession.viewport.isMobile ? 'mobile' : 'pc';
      const body = await api<{ captures: Capture[] }>(`/api/sessions/${nextSession.id}/captures`);
      const nextCapture = body.captures.at(-1);
      setDeviceSlots({ [device]: { session: nextSession, capture: nextCapture, captures: body.captures } });
      setActiveDevice(device);
      setSession(nextSession);
      setCaptures(body.captures);
      setCapture(nextCapture);
      setZoomMode('fit');
      setDraftAssets([]);
      setQuickComment(undefined);
      setTool('browse');
      setView('session');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '打开已保存会话失败');
    } finally {
      setBusy('');
    }
  }

  async function refreshSessions() {
    const body = await api<{ sessions: Session[] }>('/api/sessions');
    setSessions(body.sessions.slice().reverse());
  }

  async function refreshCaptures(sessionId = session?.id, device: DeviceKey = activeDevice) {
    if (!sessionId) return;
    const body = await api<{ captures: Capture[] }>(`/api/sessions/${sessionId}/captures`);
    setCaptures(body.captures);
    setDeviceSlots((current) => {
      const slot = current[device];
      if (!slot || slot.session.id !== sessionId) return current;
      return { ...current, [device]: { ...slot, captures: body.captures } };
    });
  }

  async function refreshBugs() {
    const body = await api<{ bugs: Bug[] }>('/api/bugs');
    setBugs(body.bugs);
  }

  async function loadBugDetail(id: string) {
    setSelectedBugId(id);
    const detail = await api<BugDetail>(`/api/bugs/${id}`);
    setBugDetail(detail);
  }

  async function patchBug(id: string, patch: Partial<Bug>) {
    const detail = await api<BugDetail>(`/api/bugs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    setBugDetail(detail);
    await refreshBugs();
  }

  async function loadCaptureSideData(captureId: string) {
    const [targetBody, annotationBody] = await Promise.all([
      api<DomTarget[]>(`/api/captures/${captureId}/dom-targets`),
      api<{ annotations: Annotation[] }>(`/api/captures/${captureId}/annotations`)
    ]);
    setDomTargets(targetBody);
    setAnnotations(annotationBody.annotations);
    setSelectedAnnotationIds([]);
    lastAnnotationIdRef.current = '';
    cancelDrawing();
  }

  async function runAction(type: string, payload: Record<string, unknown> = {}) {
    if (!session) return;
    const device = activeDevice;
    const sessionId = session.id;
    setBusy(`正在执行浏览动作：${type}`);
    setMessage('');
    try {
      const body = await api<{ session: Session; capture?: Capture }>(`/api/sessions/${session.id}/actions`, { method: 'POST', body: JSON.stringify({ type, baseSessionVersion: session.sessionVersion, ...payload }) });
      setSession(body.session);
      if (body.capture) setCapture(body.capture);
      const captureBody = await api<{ captures: Capture[] }>(`/api/sessions/${body.session.id}/captures`);
      setCaptures(captureBody.captures);
      setDeviceSlots((current) => {
        const slot = current[device];
        if (!slot || slot.session.id !== sessionId) return current;
        return { ...current, [device]: { session: body.session, capture: body.capture ?? slot.capture, captures: captureBody.captures } };
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `动作失败：${type}`);
    } finally {
      setBusy('');
    }
  }

  async function createCapture(mode: 'viewport' | 'fullPage') {
    if (!session) return;
    const device = activeDevice;
    const sessionId = session.id;
    setBusy(`正在生成${captureModeLabel(mode)}`);
    setMessage('');
    try {
      const body = await api<{ capture: Capture }>(`/api/sessions/${session.id}/captures`, { method: 'POST', body: JSON.stringify({ mode }) });
      setCapture(body.capture);
      const captureBody = await api<{ captures: Capture[] }>(`/api/sessions/${session.id}/captures`);
      setCaptures(captureBody.captures);
      setDeviceSlots((current) => {
        const slot = current[device];
        if (!slot || slot.session.id !== sessionId) return current;
        return { ...current, [device]: { ...slot, capture: body.capture, captures: captureBody.captures } };
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '截图失败');
    } finally {
      setBusy('');
    }
  }

  async function createDeviceSlot(device: DeviceKey, targetUrl: string, viewport = viewportForDevice(device)): Promise<DeviceSlot> {
    const body = await api<{ session: Session; capture: Capture }>('/api/sessions', { method: 'POST', body: JSON.stringify({ url: targetUrl, viewport, capturePolicy: 'viewport' }) });
    return { session: body.session, capture: body.capture, captures: [body.capture] };
  }

  async function setPreview(nextMode: PreviewMode) {
    if (nextMode === 'single') {
      setPreviewMode('single');
      return;
    }
    const targetUrl = capture?.finalUrl || session?.currentUrl || addressText || url;
    if (!targetUrl) return;
    setBusy('正在开启双端模拟');
    setMessage('');
    try {
      const nextSlots = { ...deviceSlots };
      for (const device of deviceOrder) {
        if (!nextSlots[device]) nextSlots[device] = await createDeviceSlot(device, targetUrl);
      }
      setDeviceSlots(nextSlots);
      setPreviewMode('dual');
      const activeSlot = nextSlots[activeDevice] ?? nextSlots.mobile ?? nextSlots.pc;
      if (activeSlot) {
        setSession(activeSlot.session);
        setCapture(activeSlot.capture);
        setCaptures(activeSlot.captures);
      }
      setQuickComment(undefined);
      setTool('browse');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '开启双端失败');
    } finally {
      setBusy('');
    }
  }

  async function navigateAddress(scope: 'active' | 'all') {
    const targetUrl = addressText.trim();
    if (!targetUrl) return;
    const devices = (scope === 'all' ? (previewMode === 'dual' ? deviceOrder : [activeDevice]) : [activeDevice]).filter((device) => deviceSlots[device]?.session.id);
    if (!devices.length) return;
    setBusy(scope === 'all' ? '正在双端打开真实地址' : `正在打开${deviceLabels[activeDevice].title}`);
    setMessage('');
    try {
      const results: Array<{ device: DeviceKey; session: Session; capture: Capture; captures: Capture[] }> = [];
      for (const device of devices) {
        const slot = deviceSlots[device]!;
        const body = await api<{ session: Session; capture: Capture }>(`/api/sessions/${slot.session.id}/navigate`, { method: 'POST', body: JSON.stringify({ url: targetUrl }) });
        const captureBody = await api<{ captures: Capture[] }>(`/api/sessions/${body.session.id}/captures`);
        results.push({ device, session: body.session, capture: body.capture, captures: captureBody.captures });
      }
      setDeviceSlots((current) => {
        const next = { ...current };
        for (const result of results) next[result.device] = { session: result.session, capture: result.capture, captures: result.captures };
        return next;
      });
      const activeResult = results.find((result) => result.device === activeDevice) ?? results[0];
      if (activeResult) {
        setActiveDevice(activeResult.device);
        setSession(activeResult.session);
        setCapture(activeResult.capture);
        setCaptures(activeResult.captures);
      }
      setQuickComment(undefined);
      setTool('browse');
      await Promise.all([refreshSessions(), refreshBugs()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '打开地址失败');
    } finally {
      setBusy('');
    }
  }

  async function addAnnotation(kind: Tool, captureRect: Rect, target?: DomTarget, paths?: Point[][]) {
    if (!capture) return;
    const pending = (async () => {
      const body = await api<{ annotation: Annotation }>(`/api/captures/${capture.id}/annotations`, {
        method: 'POST',
        body: JSON.stringify({ kind, geometry: { captureRect, paths }, target, note: draft.comment, colorRole: kind === 'element' ? 'selected' : 'bug' })
      });
      lastAnnotationIdRef.current = body.annotation.id;
      setAnnotations((current) => [...current, body.annotation]);
      setSelectedAnnotationIds((current) => [...new Set([...current, body.annotation.id])]);
      setQuickComment({ annotationId: body.annotation.id, captureId: body.annotation.captureId, rect: body.annotation.geometry.captureRect, text: body.annotation.note || draft.comment });
      if (!draft.title && body.annotation.note) setDraft((current) => ({ ...current, title: body.annotation.note.slice(0, 44), actual: body.annotation.note }));
    })();
    pendingAnnotationRef.current = pending;
    try {
      await pending;
    } finally {
      if (pendingAnnotationRef.current === pending) pendingAnnotationRef.current = undefined;
    }
  }

  async function updateAnnotation(id: string, patch: Partial<Annotation>) {
    const body = await api<{ annotation: Annotation }>(`/api/annotations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    setAnnotations((current) => current.map((annotation) => annotation.id === id ? body.annotation : annotation));
    if (selectedBugId) await loadBugDetail(selectedBugId);
  }

  async function saveQuickComment(saveAsBug = false) {
    if (!quickComment) return;
    const text = quickComment.text.trim();
    if (!text) return;
    await updateAnnotation(quickComment.annotationId, { note: text });
    const nextDraft = { ...draft, comment: text, title: draft.title || text.slice(0, 44), actual: draft.actual || text };
    setDraft(nextDraft);
    if (saveAsBug) {
      await saveBug(nextDraft, [quickComment.annotationId]);
    } else {
      setMessage('已保存标注评论。');
      closeQuickComment();
    }
  }

  async function deleteAnnotation(id: string) {
    await api<{ ok: true }>(`/api/annotations/${id}`, { method: 'DELETE' });
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
    setSelectedAnnotationIds((current) => current.filter((annotationId) => annotationId !== id));
    if (lastAnnotationIdRef.current === id) lastAnnotationIdRef.current = '';
    setQuickComment((current) => current?.annotationId === id ? undefined : current);
    if (selectedBugId) await loadBugDetail(selectedBugId);
    await refreshBugs();
  }

  async function undoLastAnnotation() {
    const id = selectedAnnotationIds.at(-1) || lastAnnotationIdRef.current || annotations.at(-1)?.id;
    if (!id) {
      setMessage('没有可撤销的标注。');
      return;
    }
    await deleteAnnotation(id);
    setMessage('已撤销最近标注。');
  }

  async function saveBug(inputDraft: DraftBug = draft, annotationIdsOverride?: string[]) {
    if (!session || !capture) return;
    if (pendingAnnotationRef.current) await pendingAnnotationRef.current;
    const completedDraft = completeDraft(inputDraft, activeTarget);
    if (!completedDraft.title || !completedDraft.actual || !completedDraft.expected || !completedDraft.severity) {
      setMessage('至少填写口语描述，或补齐标题、实际表现、期望表现和优先级。');
      return;
    }
    setDraft(completedDraft);
    const body = await api<BugDetail>(`/api/bugs`, {
      method: 'POST',
      body: JSON.stringify({
        sessionId: session.id,
        title: completedDraft.title,
        actual: completedDraft.actual,
        expected: completedDraft.expected,
        severity: completedDraft.severity,
        status: completedDraft.status,
        sourceUrl: session.sourceUrl,
        finalUrl: capture.finalUrl,
        primaryCaptureId: capture.id,
        tags: [completedDraft.bugType].filter(Boolean),
        references: referencesFromDraft(completedDraft),
        assets: draftAssets.map(({ id: _id, ...asset }) => asset),
        annotationIds: annotationIdsOverride ?? (selectedAnnotationIds.length ? selectedAnnotationIds : lastAnnotationIdRef.current ? [lastAnnotationIdRef.current] : annotations.slice(-1).map((annotation) => annotation.id))
      })
    });
    setMessage(`已保存 Bug ${body.bug.id}`);
    setBugDetail(body);
    setSelectedBugId(body.bug.id);
    setDraft(emptyDraft);
    setDraftAssets([]);
    setQuickComment(undefined);
    cancelDrawing();
    lastAnnotationIdRef.current = '';
    setSelectedAnnotationIds([]);
    await refreshBugs();
  }

  async function exportBug(bugId: string) {
    const body = await api<{ exportPath: string }>(`/api/bugs/${bugId}/export`, { method: 'POST' });
    setMessage(`证据已导出到 ${body.exportPath}`);
    await refreshBugs();
    if (selectedBugId === bugId) await loadBugDetail(bugId);
  }

  async function addDraftAssetFiles(files: FileList | File[], source: DraftAsset['kind']) {
    const imageFiles = Array.from(files).filter((file) => assetMimeTypes.includes(file.type));
    if (!imageFiles.length) return;
    const assets = await Promise.all(imageFiles.slice(0, 6).map((file) => fileToDraftAsset(file, source)));
    setDraftAssets((current) => [...current, ...assets].slice(0, 8));
    setMessage(`已加入 ${assets.length} 张对比截图。`);
  }

  function removeDraftAsset(id: string) {
    setDraftAssets((current) => current.filter((asset) => asset.id !== id));
  }

  async function normalizeBug() {
    if (!session || !capture) return;
    setBusy('AI 正在整理描述');
    setMessage('');
    try {
      const body = await api<{ result: any }>('/api/ai/normalize-bug', { method: 'POST', body: JSON.stringify({ sessionId: session.id, captureId: capture.id, annotationIds: selectedAnnotationIds.length ? selectedAnnotationIds : lastAnnotationIdRef.current ? [lastAnnotationIdRef.current] : annotations.slice(-1).map((annotation) => annotation.id), sourceText: draft.comment || draft.actual, strictness: 'strict', assets: draftAssets.map((asset) => ({ label: asset.label, fileName: asset.fileName, mimeType: asset.mimeType, dataUrl: asset.dataUrl })) }) });
      if (body.result.kind === 'draft') {
        const next = body.result.draft;
        setDraft((current) => ({ ...current, title: next.title, actual: next.actual, expected: next.expected, severity: next.severity }));
        setMessage('AI 已整理到可编辑字段。');
      } else {
        setMessage(`AI 需要补充：${body.result.questions.map((q: any) => q.question).join(' / ')}`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'AI 整理失败');
    } finally {
      setBusy('');
    }
  }

  function capturePoint(event: PointerEvent<HTMLElement>): Point {
    const img = imageRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * img.naturalWidth,
      y: ((event.clientY - rect.top) / rect.height) * img.naturalHeight
    };
  }

  function activateDevice(device: DeviceKey) {
    const slot = deviceSlots[device];
    if (!slot) return;
    cancelDrawing();
    setQuickComment(undefined);
    setTool('browse');
    setActiveDevice(device);
    setSession(slot.session);
    setCapture(slot.capture);
    setCaptures(slot.captures);
  }

  async function activateOrCreateDevice(device: DeviceKey) {
    if (deviceSlots[device]) {
      activateDevice(device);
      return;
    }
    const targetUrl = capture?.finalUrl || session?.currentUrl || addressText || url;
    if (!targetUrl) {
      setMessage('请先打开一个真实地址。');
      return;
    }
    setBusy(`正在打开${deviceLabels[device].title}`);
    setMessage('');
    try {
      const slot = await createDeviceSlot(device, targetUrl);
      setDeviceSlots((current) => ({ ...current, [device]: slot }));
      setPreviewMode('single');
      setActiveDevice(device);
      setSession(slot.session);
      setCapture(slot.capture);
      setCaptures(slot.captures);
      setZoomMode('fit');
      setTool('browse');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `打开${deviceLabels[device].title}失败`);
    } finally {
      setBusy('');
    }
  }

  function selectCapture(item: Capture) {
    setCapture(item);
    setQuickComment(undefined);
    setDeviceSlots((current) => {
      const slot = current[activeDevice];
      if (!slot || slot.session.id !== item.sessionId) return current;
      return { ...current, [activeDevice]: { ...slot, capture: item } };
    });
  }

  function zoomIn() {
    setZoomMode('manual');
    setZoomPercent((current) => Math.min(180, (zoomMode === 'fit' ? 100 : current) + 10));
  }

  function zoomOut() {
    setZoomMode('manual');
    setZoomPercent((current) => Math.max(40, (zoomMode === 'fit' ? 90 : current) - 10));
  }

  function onCanvasPointerDown(event: PointerEvent<HTMLElement>) {
    if (!capture) return;
    event.currentTarget.focus();
    const point = capturePoint(event);
    setLastPoint(point);
    if (tool === 'pointer') return;
    if (tool === 'browse') void runAction('click', { point });
    if (tool === 'pin') void addAnnotation('pin', { x: point.x, y: point.y, width: 1, height: 1 });
    if (tool === 'element') {
      const target = pickTarget(domTargets, point);
      if (target) void addAnnotation('element', target.captureRect, target);
      else void addAnnotation('pin', { x: point.x, y: point.y, width: 1, height: 1 });
    }
    if (tool === 'section') {
      const target = pickSectionTarget(domTargets, point) ?? pickTarget(domTargets, point);
      if (target) void addAnnotation('section', target.captureRect, target);
      else void addAnnotation('pin', { x: point.x, y: point.y, width: 1, height: 1 });
    }
    if (tool === 'rect' || tool === 'ellipse') {
      const existing = dragStartRef.current;
      rectPointerDownRef.current = point;
      if (existing && distance(existing, point) > 4) {
        void addAnnotation(tool, normalizeRect(existing, point));
        dragStartRef.current = undefined;
        rectPointerDownRef.current = undefined;
        setDragStart(undefined);
        setRectPreview(undefined);
      } else if (!existing) {
        dragStartRef.current = point;
        setDragStart(point);
        setRectPreview({ x: point.x, y: point.y, width: 1, height: 1 });
      }
    }
    if (tool === 'freehand') {
      freehandRef.current = [point];
      setFreehand([point]);
    }
  }

  function onCanvasPointerMove(event: PointerEvent<HTMLElement>) {
    const point = capturePoint(event);
    setLastPoint(point);
    if (tool === 'freehand' && freehandRef.current.length > 0) {
      const next = [...freehandRef.current, point];
      freehandRef.current = next;
      setFreehand(next);
    }
    if ((tool === 'rect' || tool === 'ellipse') && dragStartRef.current) setRectPreview(normalizeRect(dragStartRef.current, point));
  }

  function onCanvasWheel(event: ReactWheelEvent<HTMLElement>) {
    event.preventDefault();
    if (busy || dragStartRef.current || freehandRef.current.length) return;
    wheelDeltaRef.current = {
      x: clampWheelDelta(wheelDeltaRef.current.x + event.deltaX),
      y: clampWheelDelta(wheelDeltaRef.current.y + event.deltaY)
    };
    if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = window.setTimeout(() => {
      const delta = wheelDeltaRef.current;
      wheelDeltaRef.current = { x: 0, y: 0 };
      wheelTimerRef.current = undefined;
      if (Math.abs(delta.x) < 1 && Math.abs(delta.y) < 1) return;
      void runAction('scroll', { delta });
    }, 120);
  }

  function onCanvasKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (tool !== 'browse' || busy) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = normalizeKeyboardKey(event.key);
    if (!key) return;
    event.preventDefault();
    void runAction('key', { key });
  }

  function onCanvasPointerUp(event: PointerEvent<HTMLElement>) {
    const point = capturePoint(event);
    if ((tool === 'rect' || tool === 'ellipse') && dragStartRef.current && rectPointerDownRef.current) {
      if (distance(rectPointerDownRef.current, point) > 4) {
        void addAnnotation(tool, normalizeRect(dragStartRef.current, point));
        dragStartRef.current = undefined;
        setDragStart(undefined);
        setRectPreview(undefined);
      }
      rectPointerDownRef.current = undefined;
    }
    if (tool === 'freehand' && freehandRef.current.length > 1) {
      const path = freehandRef.current;
      const bounds = boundsForPath(path);
      void addAnnotation('freehand', bounds, undefined, [path]);
      freehandRef.current = [];
      setFreehand([]);
    }
  }

  const activeTarget = useMemo(() => lastPoint ? (tool === 'section' ? pickSectionTarget(domTargets, lastPoint) ?? pickTarget(domTargets, lastPoint) : pickTarget(domTargets, lastPoint)) : undefined, [domTargets, lastPoint, tool]);
  const activeSessionIds = useMemo(() => new Set(Object.values(deviceSlots).map((slot) => slot?.session.id).filter(Boolean) as string[]), [deviceSlots]);
  const sessionBugs = useMemo(() => bugs.filter((bug) => activeSessionIds.has(bug.sessionId) || bug.sessionId === session?.id), [activeSessionIds, bugs, session?.id]);
  const workbenchClass = ['mk-workbench', leftCollapsed ? 'is-left-collapsed' : '', rightCollapsed ? 'is-right-collapsed' : ''].filter(Boolean).join(' ');
  const boardStyle = { '--mk-preview-zoom': String(zoomPercent / 100) } as CSSProperties;
  const visibleDevices = (previewMode === 'dual' ? deviceOrder : [activeDevice]).filter((device) => deviceSlots[device]);

  return (
    <main className="mk-root">
      <nav className="mk-nav">
        <div className="mk-brand-stack"><button className="mk-wordmark" onClick={() => setView('home')}>Markit</button><span>网页 Bug 标注工作台</span></div>
        <div className="mk-nav-actions">
          <button className={view === 'session' ? 'is-active' : ''} onClick={() => setView('session')} disabled={!session}>预览</button>
          <button data-testid="nav-bugs" className={view === 'bugs' ? 'is-active' : ''} onClick={() => setView('bugs')}>Bug <span>{bugs.length}</span></button>
          <button className={view === 'settings' ? 'is-active' : ''} onClick={() => setView('settings')}>设置</button>
          <HealthBadge health={health} />
        </div>
      </nav>
      {view === 'home' ? <Home url={url} setUrl={setUrl} viewportKey={viewportKey} setViewportKey={setViewportKey} createSession={createSession} busy={busy} message={message} sessions={sessions} openSession={openExistingSession} bugs={bugs} /> : null}
      {view === 'session' && session && capture ? (
        <section className={workbenchClass} data-testid="workbench">
          <aside className="mk-left-rail" data-collapsed={leftCollapsed}>
            {leftCollapsed ? (
              <button data-testid="toggle-left-rail" className="mk-collapsed-tab" onClick={() => setLeftCollapsed(false)}><strong>评论</strong><span>{sessionBugs.length}</span></button>
            ) : (
              <>
                <div className="mk-rail-block mk-comment-thread">
                  <h2><span>评论</span><button data-testid="toggle-left-rail" aria-label="收起评论" onClick={() => setLeftCollapsed(true)}>‹</button></h2>
                  {sessionBugs.map((bug) => (
                    <button className="mk-comment-item" key={bug.id} onClick={() => { void loadBugDetail(bug.id); setView('bugs'); }}>
                      <strong>{bugSelectorLabel(bug)}</strong>
                      <span className="mk-comment-time">刚刚</span>
                      <span className="mk-comment-check" aria-hidden="true" />
                      <p>{bug.title || '未命名 Bug'}</p>
                      <small>{bug.annotationCount ?? 0} 条标注</small>
                    </button>
                  ))}
                  {sessionBugs.length === 0 ? <p className="mk-empty">还没有保存 Bug。</p> : null}
                </div>
                <div className="mk-rail-block mk-capture-thread">
                  <h2><span>快照 · {deviceLabels[activeDevice].short}</span></h2>
                  {captures.map((item) => <button className={item.id === capture.id ? 'is-active' : ''} key={item.id} onClick={() => selectCapture(item)}><span className="mk-capture-time">{new Date(item.createdAt).toLocaleTimeString()}</span><strong>{captureModeLabel(item.mode)}</strong><span>{item.viewport.name} / {item.imageSize.width}x{item.imageSize.height}</span></button>)}
                </div>
              </>
            )}
          </aside>
          <section className="mk-stage">
            <div className="mk-topbar">
              <div className="mk-tab-group">
                <span className="mk-file-tab is-active">设计文件</span>
                <span className="mk-file-tab">{deviceLabels[activeDevice].title}</span>
              </div>
              <form className="mk-address-form" onSubmit={(event) => { event.preventDefault(); void navigateAddress('all'); }}>
                <input data-testid="session-address" type="url" value={addressText} onChange={(event) => setAddressText(event.currentTarget.value)} placeholder="输入真实地址，例如 https://example.com" />
                <button data-testid="navigate-active" type="button" onClick={() => navigateAddress('active')}>打开</button>
                {previewMode === 'dual' ? <button data-testid="navigate-all" type="submit">同步双端</button> : null}
              </form>
              <div className="mk-browser-actions">
                <button onClick={() => runAction('back')}>后退</button>
                <button onClick={() => runAction('forward')}>前进</button>
                <button onClick={() => runAction('reload')}>刷新</button>
                <a className="mk-open-link" href={capture.finalUrl} target="_blank" rel="noreferrer">新窗口</a>
              </div>
            </div>
            <div className="mk-toolstrip">
              <div className="mk-toolbar-group mk-mode-group">
                <span className="mk-toolstrip-title">预览</span>
                <button data-testid="preview-single" className={previewMode === 'single' ? 'is-active' : ''} onClick={() => setPreview('single')}>单端</button>
                <button data-testid="preview-dual" className={previewMode === 'dual' ? 'is-active' : ''} onClick={() => setPreview('dual')}>双端</button>
              </div>
              <div className="mk-toolbar-group mk-device-switch">
	                {deviceOrder.map((device) => <button data-testid={`activate-${device}`} key={device} disabled={Boolean(busy)} className={activeDevice === device ? 'is-active' : ''} onClick={() => activateOrCreateDevice(device)}>{deviceLabels[device].short}</button>)}
              </div>
              <div className="mk-toolbar-group mk-tool-group">
                {primaryTools.map((item) => <button data-testid={`tool-${item}`} key={item} className={tool === item ? 'is-active' : ''} onClick={() => setTool(item)}><span>{toolLabels[item]}</span><small>{shortcutForTool(item)}</small></button>)}
              </div>
              <div className="mk-toolbar-group mk-region-tool-group">
                <button data-testid="tool-region" className={regionTools.includes(tool) ? 'mk-region-title is-active' : 'mk-region-title'} onClick={() => setTool('rect')}><span>区域标注</span><small>{toolLabels[tool] && regionTools.includes(tool) ? toolLabels[tool] : '框选'}</small></button>
                {regionTools.map((item) => <button data-testid={`tool-${item}`} key={item} className={tool === item ? 'is-active' : ''} onClick={() => setTool(item)}><span>{toolLabels[item]}</span><small>{shortcutForTool(item)}</small></button>)}
              </div>
              <div className="mk-toolbar-group mk-semantic-tool-group">
                {semanticTools.map((item) => <button data-testid={`tool-${item}`} key={item} className={tool === item ? 'is-active' : ''} onClick={() => setTool(item)}><span>{toolLabels[item]}</span><small>{shortcutForTool(item)}</small></button>)}
              </div>
              <div className="mk-toolbar-group mk-capture-actions">
                <button data-testid="capture-viewport" onClick={() => createCapture('viewport')}>截取视口</button>
                <button data-testid="capture-fullpage" onClick={() => createCapture('fullPage')}>整页截图</button>
                <button data-testid="undo-annotation" onClick={undoLastAnnotation} disabled={!annotations.length}>撤销标注 <small>Z</small></button>
                <button data-testid="scroll-down" onClick={() => runAction('scroll', { delta: { x: 0, y: 520 } })}>向下滚动</button>
              </div>
              <div className="mk-toolbar-group mk-input-actions">
                <input data-testid="action-text" value={actionText} onChange={(event) => setActionText(event.currentTarget.value)} placeholder="选中位置后输入文本" />
                <button data-testid="type-action" onClick={() => runAction('type', { point: lastPoint, selector: activeTarget?.selector, text: actionText })}>输入</button>
                <button onClick={() => runAction('key', { key: 'Enter' })}>回车</button>
              </div>
              <div className="mk-zoom-controls" aria-label="缩放控制">
                <button data-testid="zoom-out" onClick={zoomOut}>−</button>
                <button data-testid="zoom-fit" className={zoomMode === 'fit' ? 'is-active' : ''} onClick={() => setZoomMode('fit')}>适应</button>
                <span data-testid="zoom-label">{zoomMode === 'fit' ? 'Fit' : `${zoomPercent}%`}</span>
                <button data-testid="zoom-in" onClick={zoomIn}>+</button>
              </div>
            </div>
            <div className="mk-canvas-wrap">
	              <div data-testid="device-board" className={['mk-device-board', previewMode === 'dual' ? 'is-dual' : 'is-single', zoomMode === 'fit' ? 'is-fit' : 'is-manual'].join(' ')} style={boardStyle}>
                {visibleDevices.map((device) => (
                  <DeviceFrame
                    key={device}
                    device={device}
                    slot={deviceSlots[device]}
                    active={device === activeDevice}
                    zoomMode={zoomMode}
                    zoomPercent={zoomPercent}
                    imageRef={imageRef}
                    tool={tool}
                    domTargets={domTargets}
                    activeTarget={activeTarget}
                    annotations={annotations}
                    selectedAnnotationIds={selectedAnnotationIds}
                    dragStart={dragStart}
                    rectPreview={rectPreview}
                    freehand={freehand}
                    quickComment={quickComment?.captureId === deviceSlots[device]?.capture?.id ? quickComment : undefined}
                    setQuickComment={setQuickComment}
                    onCloseQuickComment={closeQuickComment}
                    onSaveQuickComment={saveQuickComment}
                    onActivate={activateDevice}
                    onPointerDown={onCanvasPointerDown}
                    onPointerMove={onCanvasPointerMove}
                    onPointerUp={onCanvasPointerUp}
                    onWheel={onCanvasWheel}
                    onKeyDown={onCanvasKeyDown}
                  />
                ))}
              </div>
            </div>
            {busy ? <div className="mk-busy">{busy}</div> : null}
            {message ? <div className="mk-message">{message}</div> : null}
          </section>
          <aside className="mk-right-panel" data-collapsed={rightCollapsed}>
            {rightCollapsed ? (
              <button data-testid="toggle-right-panel" className="mk-collapsed-tab" onClick={() => setRightCollapsed(false)}><strong>检查</strong><span>{annotations.length}</span></button>
            ) : (
              <>
                <div className="mk-panel-toolbar"><strong>检查器</strong><button data-testid="toggle-right-panel" aria-label="收起检查器" onClick={() => setRightCollapsed(true)}>›</button></div>
                <BugPanel draft={draft} setDraft={setDraft} draftAssets={draftAssets} addDraftAssetFiles={addDraftAssetFiles} removeDraftAsset={removeDraftAsset} annotations={annotations} selectedAnnotationIds={selectedAnnotationIds} setSelectedAnnotationIds={setSelectedAnnotationIds} saveBug={() => saveBug()} normalizeBug={normalizeBug} aiStatus={aiStatus} activeTarget={activeTarget} lastPoint={lastPoint} session={session} capture={capture} updateAnnotation={updateAnnotation} deleteAnnotation={deleteAnnotation} />
              </>
            )}
          </aside>
        </section>
      ) : null}
      {view === 'bugs' ? <BugsView bugs={bugs} selectedBugId={selectedBugId} bugDetail={bugDetail} loadBugDetail={loadBugDetail} patchBug={patchBug} exportBug={exportBug} /> : null}
      {view === 'settings' ? <Settings aiStatus={aiStatus} /> : null}
    </main>
  );
}

function DeviceFrame(props: {
  device: DeviceKey;
  slot: DeviceSlot | undefined;
  active: boolean;
  zoomMode: ZoomMode;
  zoomPercent: number;
  imageRef: RefObject<HTMLImageElement | null>;
  tool: Tool;
  domTargets: DomTarget[];
  activeTarget: DomTarget | undefined;
  annotations: Annotation[];
  selectedAnnotationIds: string[];
  dragStart: Point | undefined;
  rectPreview: Rect | undefined;
  freehand: Point[];
  quickComment: QuickComment | undefined;
  setQuickComment: Dispatch<SetStateAction<QuickComment | undefined>>;
  onCloseQuickComment: () => void;
  onSaveQuickComment: (saveAsBug?: boolean) => void | Promise<void>;
  onActivate: (device: DeviceKey) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onWheel: (event: ReactWheelEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  const capture = props.slot?.capture;
  const label = deviceLabels[props.device];
  const layerStyle = props.zoomMode === 'manual' && capture
    ? { width: `${Math.max(120, Math.round(capture.imageSize.width * (props.zoomPercent / 100)))}px` }
    : undefined;
  return (
    <article data-testid={`device-${props.device}`} className={['mk-device-frame', `mk-device-${props.device}`, props.active ? 'is-active' : '', props.active && props.tool === 'browse' ? 'is-browse-tool' : ''].filter(Boolean).join(' ')}>
      <button className="mk-device-header" onClick={() => props.onActivate(props.device)} type="button">
        <span><strong>{label.title}</strong><small>{capture ? `${capture.viewport.width}x${capture.viewport.height}` : label.hint}</small></span>
        <em>{props.active ? (props.tool === 'browse' ? '正在浏览' : '正在标注') : '点击切换'}</em>
      </button>
      <div className="mk-device-shell">
        {capture ? (
          <div
            data-testid={props.active ? 'canvas-layer' : undefined}
            className="mk-image-layer"
            style={layerStyle}
            tabIndex={props.active ? 0 : -1}
            data-live-canvas={props.active ? 'true' : undefined}
            onPointerDown={props.active ? props.onPointerDown : undefined}
            onPointerMove={props.active ? props.onPointerMove : undefined}
            onPointerUp={props.active ? props.onPointerUp : undefined}
            onWheel={props.active ? props.onWheel : undefined}
            onKeyDown={props.active ? props.onKeyDown : undefined}
          >
            <img ref={props.active ? props.imageRef : undefined} draggable={false} src={`/api/captures/${capture.id}/image`} alt={`${label.title}截图`} />
            {props.active ? (
              <svg className="mk-overlay" viewBox={`0 0 ${capture.imageSize.width} ${capture.imageSize.height}`}>
                {props.domTargets.map((target) => props.tool === 'element' ? <rect key={target.id} className="mk-target-rect" x={target.captureRect.x} y={target.captureRect.y} width={target.captureRect.width} height={target.captureRect.height} /> : null)}
                {props.activeTarget && ['pointer', 'element', 'section'].includes(props.tool) ? <rect className="mk-target-active" x={props.activeTarget.captureRect.x} y={props.activeTarget.captureRect.y} width={props.activeTarget.captureRect.width} height={props.activeTarget.captureRect.height} /> : null}
                {props.annotations.map((annotation, index) => <AnnotationShape key={annotation.id} annotation={annotation} selected={props.selectedAnnotationIds.includes(annotation.id)} index={index + 1} />)}
                {props.dragStart ? <circle className="mk-rect-start" cx={props.dragStart.x} cy={props.dragStart.y} r="6" /> : null}
                {props.rectPreview && (props.rectPreview.width > 2 || props.rectPreview.height > 2) ? (
                  props.tool === 'ellipse'
                    ? <ellipse className="mk-ann-preview" cx={props.rectPreview.x + Math.max(props.rectPreview.width, 1) / 2} cy={props.rectPreview.y + Math.max(props.rectPreview.height, 1) / 2} rx={Math.max(props.rectPreview.width, 1) / 2} ry={Math.max(props.rectPreview.height, 1) / 2} />
                    : <rect className="mk-ann-preview" x={props.rectPreview.x} y={props.rectPreview.y} width={Math.max(props.rectPreview.width, 1)} height={Math.max(props.rectPreview.height, 1)} />
                ) : null}
                {props.freehand.length > 1 ? <polyline className="mk-ann-freehand" points={props.freehand.map((p) => `${p.x},${p.y}`).join(' ')} /> : null}
              </svg>
            ) : null}
            {props.active && props.quickComment ? (
              <QuickCommentPopover
                comment={props.quickComment}
                imageSize={capture.imageSize}
                onChange={(text) => props.setQuickComment((current) => current ? { ...current, text } : current)}
                onClose={props.onCloseQuickComment}
                onSave={() => props.onSaveQuickComment(false)}
                onSaveBug={() => props.onSaveQuickComment(true)}
              />
            ) : null}
          </div>
        ) : (
          <p className="mk-empty">暂无{label.title}截图。</p>
        )}
      </div>
    </article>
  );
}

function QuickCommentPopover(props: { comment: QuickComment; imageSize: { width: number; height: number }; onChange: (text: string) => void; onClose: () => void; onSave: () => void | Promise<void>; onSaveBug: () => void | Promise<void> }) {
  const rect = props.comment.rect;
  const left = ((rect.x + Math.min(rect.width, 28)) / props.imageSize.width) * 100;
  const top = ((rect.y + Math.min(rect.height, 28)) / props.imageSize.height) * 100;
  const clampedLeft = Math.min(92, Math.max(3, left));
  const clampedTop = Math.min(86, Math.max(3, top));
  const rightAnchored = clampedLeft > 62;
  const bottomAnchored = clampedTop > 64;
  const style: CSSProperties = {
    ...(rightAnchored ? { right: `${Math.min(92, Math.max(3, 100 - clampedLeft))}%` } : { left: `${clampedLeft}%` }),
    ...(bottomAnchored ? { bottom: `${Math.min(86, Math.max(3, 100 - clampedTop))}%` } : { top: `${clampedTop}%` })
  };
  const stopCanvasPropagation = (event: ReactSyntheticEvent) => event.stopPropagation();
  return (
    <div
      className={['mk-quick-comment-popover', rightAnchored ? 'is-right-anchored' : '', bottomAnchored ? 'is-bottom-anchored' : ''].filter(Boolean).join(' ')}
      data-testid="quick-comment-popover"
      style={style}
      role="dialog"
      aria-label="快速评论"
      onPointerDown={stopCanvasPropagation}
      onPointerMove={stopCanvasPropagation}
      onPointerUp={stopCanvasPropagation}
      onPointerCancel={stopCanvasPropagation}
      onClick={stopCanvasPropagation}
      onDoubleClick={stopCanvasPropagation}
      onWheel={stopCanvasPropagation}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          props.onClose();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && props.comment.text.trim()) {
          event.preventDefault();
          void props.onSave();
        }
      }}
    >
      <div className="mk-quick-comment-head"><strong>快速评论</strong><button aria-label="关闭快速评论" onClick={props.onClose}>×</button></div>
      <textarea data-testid="quick-comment-input" autoFocus value={props.comment.text} onChange={(event) => props.onChange(event.currentTarget.value)} placeholder="直接描述这个标注，比如：这里的按钮颜色和 Figma 不一致" />
      <div className="mk-quick-comment-actions">
        <button onClick={() => props.onSave()} disabled={!props.comment.text.trim()}>保存评论</button>
        <button className="primary" data-testid="quick-comment-save-bug" onClick={() => props.onSaveBug()} disabled={!props.comment.text.trim()}>保存为 Bug</button>
      </div>
    </div>
  );
}

function Home(props: { url: string; setUrl: (value: string) => void; viewportKey: string; setViewportKey: (value: string) => void; createSession: (event: FormEvent) => void; busy: string; message: string; sessions: Session[]; openSession: (session: Session) => void; bugs: Bug[] }) {
  return (
    <section className="mk-home-card">
      <div className="mk-kicker">本地网页验收</div>
      <h1>Markit</h1>
      <p>把任意真实 URL 变成可点击、可标注、可导出证据的 Bug 工作台；默认单端验收，需要时再切换 PC / Mobile 或开启双端对照。</p>
      <form className="mk-url-form" onSubmit={props.createSession}>
        <label>
          <span>URL</span>
          <input data-testid="url-input" type="url" required value={props.url} onChange={(event) => props.setUrl(event.currentTarget.value)} placeholder="https://example.com 或 http://localhost:3000" />
        </label>
        <label>
          <span>视口</span>
          <select data-testid="viewport-select" value={props.viewportKey} onChange={(event) => props.setViewportKey(event.currentTarget.value)}>{viewportOptions.map((viewport) => <option key={viewport.key} value={viewport.key}>{viewport.name}</option>)}</select>
        </label>
        <button data-testid="open-session" disabled={Boolean(props.busy)}>{props.busy || '打开会话'}</button>
      </form>
      {props.message ? <p className="mk-message">{props.message}</p> : null}
      <div className="mk-home-grid">
        <section>
          <h2>最近会话</h2>
          {props.sessions.length ? props.sessions.slice(0, 6).map((session) => <button className="mk-session-row" key={session.id} onClick={() => props.openSession(session)}><strong>{safeHost(session.currentUrl)}</strong><span>{session.viewport.name}</span><small>{props.bugs.filter((bug) => bug.sessionId === session.id).length} 个 Bug</small></button>) : <p className="mk-empty">还没有保存会话。</p>}
        </section>
        <section>
              <h2>覆盖能力</h2>
              <div className="mk-coverage"><span>真实 URL</span><span>单端默认 / 双端可选</span><span>点击 / 滚动 / 输入</span><span>标记 / 框选 / 圈选 / 自由画 / 元素 / 区块</span><span>少填字段快速保存</span><span>需求/Figma 引用</span><span>AI 描述整理</span></div>
        </section>
      </div>
    </section>
  );
}

function BugPanel(props: {
  draft: DraftBug;
  setDraft: Dispatch<SetStateAction<DraftBug>>;
  draftAssets: DraftAsset[];
  addDraftAssetFiles: (files: FileList | File[], source: DraftAsset['kind']) => Promise<void>;
  removeDraftAsset: (id: string) => void;
  annotations: Annotation[];
  selectedAnnotationIds: string[];
  setSelectedAnnotationIds: Dispatch<SetStateAction<string[]>>;
  saveBug: () => void;
  normalizeBug: () => void;
  aiStatus: AiStatus;
  activeTarget: DomTarget | undefined;
  lastPoint: Point | undefined;
  session: Session;
  capture: Capture;
  updateAnnotation: (id: string, patch: Partial<Annotation>) => Promise<void>;
  deleteAnnotation: (id: string) => Promise<void>;
}) {
  const update = (key: keyof DraftBug, value: string) => props.setDraft((current) => ({ ...current, [key]: value }));
  const canSave = Boolean((props.draft.title && props.draft.actual && props.draft.expected && props.draft.severity) || props.draft.comment.trim());
  const onAssetInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.files) void props.addDraftAssetFiles(event.currentTarget.files, 'uploaded-screenshot');
    event.currentTarget.value = '';
  };
  const onDrop = (event: ReactDragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer.files).filter((file) => assetMimeTypes.includes(file.type));
    if (!files.length) return;
    event.preventDefault();
    void props.addDraftAssetFiles(files, 'uploaded-screenshot');
  };
  return (
    <div className="mk-bug-panel">
      <section className="mk-panel-section mk-draft-card">
        <h2>评论此元素</h2>
        <div className="mk-quick-group" data-testid="bug-type-chips">
          {bugTypeOptions.map((item) => <button type="button" key={item.value} className={props.draft.bugType === item.value ? 'is-active' : ''} onClick={() => update('bugType', item.value)}>{item.label}</button>)}
        </div>
        <label>标题<input data-testid="bug-title" value={props.draft.title} onChange={(event) => update('title', event.currentTarget.value)} /></label>
        <div className="mk-two-col">
          <label>优先级<select data-testid="bug-severity" value={props.draft.severity} onChange={(event) => update('severity', event.currentTarget.value)}><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label>
          <label>状态<select data-testid="bug-status" value={props.draft.status} onChange={(event) => update('status', event.currentTarget.value)}>{statusOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        </div>
        <label>实际表现<textarea data-testid="bug-actual" value={props.draft.actual} onChange={(event) => update('actual', event.currentTarget.value)} /></label>
        <label>期望表现<textarea data-testid="bug-expected" value={props.draft.expected} onChange={(event) => update('expected', event.currentTarget.value)} /></label>
        <label>口语描述<textarea data-testid="bug-comment" value={props.draft.comment} onChange={(event) => update('comment', event.currentTarget.value)} placeholder="少填版：这里只要写一句问题，比如“Mobile 下拉最后一行被截断”" /></label>
        <details className="mk-reference-fields">
          <summary>引用 / 对比（可选）</summary>
          <label>原始需求链接<input data-testid="requirement-url" type="url" value={props.draft.requirementUrl} onChange={(event) => update('requirementUrl', event.currentTarget.value)} placeholder="飞书需求 / PRD / issue URL" /></label>
          <label>Figma 或设计图链接<input data-testid="design-url" type="url" value={props.draft.designUrl} onChange={(event) => update('designUrl', event.currentTarget.value)} placeholder="Figma / 对比截图 URL" /></label>
        </details>
        <section className="mk-asset-dropzone" data-testid="asset-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
          <div><strong>截图 / 对比证据</strong><span>可在工作台任意位置 Cmd+V 粘贴截图，或拖入 / 上传 Figma、测试截图。</span></div>
          <label className="mk-upload-button">上传截图<input data-testid="asset-upload-input" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={onAssetInput} /></label>
          {props.draftAssets.length ? (
            <div className="mk-asset-preview-list" data-testid="asset-preview-list">
              {props.draftAssets.map((asset) => (
                <article key={asset.id}>
                  <img src={asset.dataUrl} alt={asset.label} />
                  <div><strong>{asset.label}</strong><span>{asset.fileName} · {formatBytes(asset.sizeBytes)}</span></div>
                  <button type="button" onClick={() => props.removeDraftAsset(asset.id)}>移除</button>
                </article>
              ))}
            </div>
          ) : null}
        </section>
        <div className="mk-button-pair"><button data-testid="normalize-bug" onClick={props.normalizeBug} disabled={!props.aiStatus.enabled}>整理描述（{props.aiStatus.provider}{props.aiStatus.supportsImages ? '+图片' : ''}）</button><button data-testid="save-bug" onClick={props.saveBug} disabled={!canSave}>快速保存</button></div>
        <small>快捷：1/2/3/4 设 P0/P1/P2/P3，A 快速保存，Z 撤销标注，O 圈选，D 自由画；画布滚轮会滚动真实页面。</small>
        {!props.aiStatus.enabled ? <small>{props.aiStatus.reason}</small> : null}
      </section>
      <section className="mk-panel-section mk-target-card">
        <h2>点击识别</h2>
        {props.activeTarget ? <dl data-testid="active-target"><dt>选择器</dt><dd>{props.activeTarget.selector}</dd><dt>标签</dt><dd>{props.activeTarget.label || props.activeTarget.text || props.activeTarget.tagName}</dd>{props.activeTarget.value ? <><dt>值</dt><dd>{props.activeTarget.value}</dd></> : null}<dt>评分</dt><dd>{props.activeTarget.selectorScore}</dd></dl> : <p className="mk-empty">在画布上移动或点击，自动识别 DOM 目标。</p>}
        {props.lastPoint ? <small>坐标 {props.lastPoint.x.toFixed(0)}, {props.lastPoint.y.toFixed(0)}</small> : null}
      </section>
      <section className="mk-panel-section mk-ann-list">
        <h3>标注</h3>
        {props.annotations.map((annotation, index) => (
          <article key={annotation.id} className={props.selectedAnnotationIds.includes(annotation.id) ? 'is-selected' : ''}>
            <label><input type="checkbox" checked={props.selectedAnnotationIds.includes(annotation.id)} onChange={(event) => props.setSelectedAnnotationIds((current) => event.currentTarget.checked ? [...new Set([...current, annotation.id])] : current.filter((id) => id !== annotation.id))} /> <strong>#{index + 1} {annotationKindLabels[annotation.kind] ?? annotation.kind}</strong></label>
            <input aria-label={`note-${annotation.id}`} value={annotation.note} placeholder="标注说明" onChange={(event) => props.updateAnnotation(annotation.id, { note: event.currentTarget.value })} />
            {annotation.target ? <small>{annotation.target.selector}</small> : null}
            <button className="mk-danger-button" onClick={() => props.deleteAnnotation(annotation.id)}>删除标注</button>
          </article>
        ))}
        {props.annotations.length === 0 ? <p className="mk-empty">还没有标注。</p> : null}
      </section>
      <section className="mk-panel-section mk-meta-list">
        <h2>截图信息</h2>
        <dl><dt>视口</dt><dd>{props.capture.viewport.name}</dd><dt>模式</dt><dd>{captureModeLabel(props.capture.mode)}</dd><dt>来源</dt><dd>{props.session.sourceUrl}</dd><dt>最终地址</dt><dd>{props.capture.finalUrl}</dd></dl>
      </section>
    </div>
  );
}

function BugsView(props: { bugs: Bug[]; selectedBugId: string; bugDetail: BugDetail | undefined; loadBugDetail: (id: string) => Promise<void>; patchBug: (id: string, patch: Partial<Bug>) => Promise<void>; exportBug: (id: string) => void }) {
  useEffect(() => {
    if (!props.selectedBugId && props.bugs[0]) void props.loadBugDetail(props.bugs[0].id);
  }, [props.bugs.length, props.selectedBugId]);
  return (
    <section className="mk-bugs-page">
      <div className="mk-page-heading"><div><span className="mk-kicker">OpenDesign 评论式收件箱</span><h1>Bug 列表</h1></div><p>已捕获 {props.bugs.length} 个带截图证据的问题。</p></div>
      <div className="mk-bugs-layout">
        <div className="mk-bug-grid">
          {props.bugs.map((bug) => (
            <article data-testid="bug-card" className={bug.id === props.selectedBugId ? 'mk-bug-card is-active' : 'mk-bug-card'} key={bug.id} onClick={() => props.loadBugDetail(bug.id)}>
              <div className="mk-card-top"><strong>{bug.severity}</strong><span>{statusLabels[bug.status] ?? bug.status}</span></div>
              <div className="mk-card-tags">{bug.tags?.[0] ? <em>{bugTypeLabel(bug.tags[0])}</em> : null}<small>{safeHost(bug.finalUrl)}</small></div>
              <h2>{bug.title}</h2>
              <p>{bug.actual}</p>
              <span data-testid="bug-annotation-count">{bug.annotationCount ?? 0} 条标注</span>
              {bug.assetCount ? <span className="mk-reference-count">{bug.assetCount} 张截图</span> : null}
              {bug.references?.length ? <span className="mk-reference-count">{bug.references.length} 个引用</span> : null}
              <button data-testid="export-evidence" onClick={(event) => { event.stopPropagation(); props.exportBug(bug.id); }}>导出证据</button>
              {bug.exportPath ? <small>{bug.exportPath}</small> : null}
            </article>
          ))}
          {props.bugs.length === 0 ? <p className="mk-empty">还没有保存 Bug。</p> : null}
        </div>
        <BugDetailPanel detail={props.bugDetail} patchBug={props.patchBug} exportBug={props.exportBug} />
      </div>
    </section>
  );
}

function BugDetailPanel({ detail, patchBug, exportBug }: { detail: BugDetail | undefined; patchBug: (id: string, patch: Partial<Bug>) => Promise<void>; exportBug: (id: string) => void }) {
  const [edit, setEdit] = useState<Bug | undefined>(detail?.bug);
  useEffect(() => setEdit(detail?.bug), [detail?.bug.id]);
  if (!detail || !edit) return <aside className="mk-bug-detail"><p className="mk-empty">选择一个 Bug 查看证据。</p></aside>;
  return (
    <aside className="mk-bug-detail" data-testid="bug-detail">
      <div className="mk-detail-head"><div><span>{detail.bug.id}</span><h2>{detail.bug.title}</h2></div><button data-testid="detail-export" onClick={() => exportBug(detail.bug.id)}>导出证据</button></div>
      <div className="mk-two-col">
        <label>优先级<select value={edit.severity} onChange={(event) => setEdit((current) => current ? { ...current, severity: event.currentTarget.value } : current)}><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label>
        <label>状态<select value={edit.status} onChange={(event) => setEdit((current) => current ? { ...current, status: event.currentTarget.value } : current)}>{statusOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      </div>
      <label>标题<input value={edit.title} onChange={(event) => setEdit((current) => current ? { ...current, title: event.currentTarget.value } : current)} /></label>
      <label>实际表现<textarea value={edit.actual} onChange={(event) => setEdit((current) => current ? { ...current, actual: event.currentTarget.value } : current)} /></label>
      <label>期望表现<textarea value={edit.expected} onChange={(event) => setEdit((current) => current ? { ...current, expected: event.currentTarget.value } : current)} /></label>
      <button onClick={() => patchBug(detail.bug.id, edit)}>保存详情修改</button>
      <dl className="mk-detail-meta"><dt>来源 URL</dt><dd>{detail.bug.sourceUrl}</dd><dt>最终 URL</dt><dd>{detail.bug.finalUrl}</dd><dt>导出路径</dt><dd>{detail.bug.exportPath || '尚未导出'}</dd></dl>
      {detail.bug.references.length ? <section className="mk-detail-evidence"><h3>引用 / 对比</h3>{detail.bug.references.map((reference) => <article key={`${reference.kind}-${reference.url}`}><strong>{reference.label ?? reference.kind}</strong><p>{reference.url}</p></article>)}</section> : null}
      {detail.assets.length ? <section className="mk-detail-evidence"><h3>截图 / 对比证据</h3><div className="mk-detail-assets">{detail.assets.map((asset) => <article key={asset.id}><img src={`/api/bug-assets/${asset.id}/image`} alt={asset.label || asset.fileName} /><strong>{asset.label || asset.kind}</strong><p>{asset.fileName} · {formatBytes(asset.sizeBytes)}</p></article>)}</div></section> : null}
      <section className="mk-detail-evidence"><h3>证据</h3>{detail.annotations.map((annotation, index) => <article key={annotation.id}><strong>#{index + 1} {annotationKindLabels[annotation.kind] ?? annotation.kind}</strong><p>{annotation.note || detail.bug.title}</p>{annotation.target ? <small>{annotation.target.selector}</small> : null}</article>)}{detail.annotations.length === 0 ? <p className="mk-empty">还没有绑定标注证据。</p> : null}</section>
    </aside>
  );
}

function Settings({ aiStatus }: { aiStatus: AiStatus }) {
  return <section className="mk-settings"><h1>设置</h1><dl><dt>存储位置</dt><dd>.markit/</dd><dt>AI 通道</dt><dd>{aiStatus.provider} {aiStatus.enabled ? '已启用' : '未启用'}{aiStatus.supportsImages ? '，支持图片输入' : ''}{aiStatus.configSource ? `，来源 ${aiStatus.configSource}` : ''}</dd><dt>隐私</dt><dd>默认不会把截图字节发送给模型；仅在开启 MMF / multimodal provider 并点击整理描述时发送对比截图。</dd><dt>快捷键</dt><dd>B 浏览 / V 指针 / P 标记 / R 框选 / O 圈选 / D 自由画 / E 元素 / S 区块 / C 截图 / F 适应 / A 快速保存 / Z 撤销标注 / 1-4 优先级 / Cmd+S 保存 / Cmd+V 粘贴截图</dd></dl></section>;
}

function AnnotationShape({ annotation, selected, index }: { annotation: Annotation; selected: boolean; index: number }) {
  const rect = annotation.geometry.captureRect;
  const labelX = Math.max(8, rect.x + 8);
  const labelY = Math.max(18, rect.y + 20);
  if (annotation.kind === 'pin') return <g><circle className={selected ? 'mk-ann-pin is-selected' : 'mk-ann-pin'} cx={rect.x} cy={rect.y} r="8" /><text className="mk-ann-label" x={rect.x + 11} y={rect.y - 10}>{index}</text></g>;
  if (annotation.kind === 'ellipse') return <g><ellipse className={selected ? 'mk-ann-ellipse is-selected' : 'mk-ann-ellipse'} cx={rect.x + Math.max(rect.width, 8) / 2} cy={rect.y + Math.max(rect.height, 8) / 2} rx={Math.max(rect.width, 8) / 2} ry={Math.max(rect.height, 8) / 2} /><text className="mk-ann-label" x={labelX} y={labelY}>{index}</text></g>;
  if (annotation.kind === 'freehand' && annotation.geometry.paths?.[0]) return <g><polyline className="mk-ann-freehand" points={annotation.geometry.paths[0].map((p) => `${p.x},${p.y}`).join(' ')} /><text className="mk-ann-label" x={labelX} y={labelY}>{index}</text></g>;
  return <g><rect className={selected ? 'mk-ann-rect is-selected' : 'mk-ann-rect'} x={rect.x} y={rect.y} width={Math.max(rect.width, 8)} height={Math.max(rect.height, 8)} /><text className="mk-ann-label" x={labelX} y={labelY}>{index}</text></g>;
}

function HealthBadge({ health }: { health: HealthState }) {
  if (health.kind === 'loading') return <span data-testid="health-badge" className="mk-health mk-health-loading">检查中</span>;
  if (health.kind === 'error') return <span data-testid="health-badge" className="mk-health mk-health-error">服务离线</span>;
  return <span data-testid="health-badge" className="mk-health mk-health-ok">服务 {health.version}</span>;
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...init });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(body?.error?.message || `${response.status} ${response.statusText}`);
  return body as T;
}

function completeDraft(draft: DraftBug, target?: DomTarget): DraftBug {
  const comment = draft.comment.trim();
  const type = bugTypeOptions.find((item) => item.value === draft.bugType) ?? bugTypeOptions[0]!;
  const targetLabel = target?.label || target?.text || target?.tagName || '当前标注区域';
  const currentTitle = draft.title.trim();
  const currentActual = draft.actual.trim();
  const autoFilledFromOldComment = Boolean(comment && currentTitle && currentActual && currentTitle === currentActual);
  const title = autoFilledFromOldComment || !currentTitle ? (comment ? comment.replace(/\s+/g, ' ').slice(0, 44) : `${type.label}：${targetLabel}`.slice(0, 44)) : currentTitle;
  const actual = autoFilledFromOldComment || !currentActual ? comment : currentActual;
  const expected = draft.expected.trim() || type.expected;
  return { ...draft, title, actual, expected };
}

function referencesFromDraft(draft: DraftBug): BugReference[] {
  const references: BugReference[] = [];
  if (isHttpUrl(draft.requirementUrl)) references.push({ kind: 'requirement', url: draft.requirementUrl.trim(), label: '原始需求' });
  if (isHttpUrl(draft.designUrl)) references.push({ kind: 'design', url: draft.designUrl.trim(), label: /figma/i.test(draft.designUrl) ? 'Figma' : '设计/对比图' });
  return references;
}

function fileToDraftAsset(file: File, kind: DraftAsset['kind']): Promise<DraftAsset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读取截图失败'));
    reader.onload = () => resolve({
      id: `draft_asset_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      kind,
      fileName: file.name || (kind === 'pasted-screenshot' ? '粘贴截图.png' : '上传截图.png'),
      mimeType: file.type,
      sizeBytes: file.size,
      dataUrl: String(reader.result),
      label: kind === 'pasted-screenshot' ? '粘贴截图' : '上传截图'
    });
    reader.readAsDataURL(file);
  });
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeRect(start: Point, end: Point): Rect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

function boundsForPath(path: Point[]): Rect {
  const xs = path.map((p) => p.x);
  const ys = path.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

function clampWheelDelta(value: number): number {
  return Math.max(-900, Math.min(900, value));
}

function pickTarget(targets: DomTarget[], point: Point): DomTarget | undefined {
  return targets.filter((target) => point.x >= target.captureRect.x && point.y >= target.captureRect.y && point.x <= target.captureRect.x + target.captureRect.width && point.y <= target.captureRect.y + target.captureRect.height).sort((a, b) => (a.captureRect.width * a.captureRect.height) - (b.captureRect.width * b.captureRect.height) || b.selectorScore - a.selectorScore)[0];
}

function pickSectionTarget(targets: DomTarget[], point: Point): DomTarget | undefined {
  const semanticRank: Record<string, number> = { article: 1, section: 2, main: 3, nav: 4, aside: 4, header: 4, footer: 4, form: 4 };
  const candidates = targets
    .filter((target) => rectContainsPoint(target.captureRect, point))
    .filter((target) => semanticRank[target.tagName] || (target.captureRect.width >= 160 && target.captureRect.height >= 72));
  return candidates.sort((a, b) => {
    const rankDelta = (semanticRank[a.tagName] ?? 10) - (semanticRank[b.tagName] ?? 10);
    if (rankDelta !== 0) return rankDelta;
    const areaDelta = rectArea(a.captureRect) - rectArea(b.captureRect);
    return areaDelta || b.selectorScore - a.selectorScore;
  })[0];
}

function rectContainsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function shortcutForTool(tool: Tool): string {
  return ({ browse: 'B', pointer: 'V', pin: 'P', rect: 'R', ellipse: 'O', freehand: 'D', element: 'E', section: 'S' } as Record<Tool, string>)[tool];
}

function bugTypeLabel(value: string): string {
  return bugTypeOptions.find((item) => item.value === value)?.label ?? value;
}

function deviceForViewport(viewport: Viewport): DeviceKey {
  return viewport.isMobile || viewport.width < 900 ? 'mobile' : 'pc';
}

function viewportForDevice(device: DeviceKey): Viewport {
  return device === 'pc' ? desktopViewport : fallbackMobileViewport;
}

function normalizeKeyboardKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key;
  const allowed = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  return allowed.has(key) ? key : '';
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function bugSelectorLabel(bug: Bug): string {
  if (/dropdown/i.test(bug.title)) return 'div.dropdown';
  if (/下拉菜单/.test(bug.title)) return 'div.dropdown';
  if (/Hero|CTA|主操作按钮/i.test(bug.title)) return 'a.btn.btn-primary';
  if (/菜单/.test(bug.title)) return 'button.menu';
  if (/图表|CPI/i.test(bug.title)) return 'span.chart-label';
  if (/国家卡片/.test(bug.title)) return 'article.card';
  return 'div.container';
}
