// Document Processing Status Monitor
// Real-time status updates and progress tracking

class DocumentStatusMonitor {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.processor = null;
    this.isInitialized = false;
  }

  // Initialize the status monitor
  init(documentProcessor) {
    this.processor = documentProcessor;
    this.setupStatusDisplay();
    this.bindEvents();
    this.isInitialized = true;
    console.log('Document status monitor initialized');
  }

  // Set up the status display UI
  setupStatusDisplay() {
    if (!this.container) {
      console.error('Status monitor container not found');
      return;
    }

    this.container.innerHTML = `
      <div class="status-monitor">
        <div class="status-header">
          <h3>📊 Processing Status</h3>
          <div class="status-actions">
            <button id="refreshStatus" class="btn btn-secondary btn-sm">🔄 Refresh</button>
            <button id="clearCompleted" class="btn btn-secondary btn-sm">🗑️ Clear Completed</button>
          </div>
        </div>

        <div class="status-overview">
          <div class="stat-card">
            <div class="stat-number" id="totalFiles">0</div>
            <div class="stat-label">Total Files</div>
          </div>
          <div class="stat-card">
            <div class="stat-number" id="queuedFiles">0</div>
            <div class="stat-label">Queued</div>
          </div>
          <div class="stat-card processing">
            <div class="stat-number" id="processingFiles">0</div>
            <div class="stat-label">Processing</div>
          </div>
          <div class="stat-card success">
            <div class="stat-number" id="completedFiles">0</div>
            <div class="stat-label">Completed</div>
          </div>
          <div class="stat-card error">
            <div class="stat-number" id="failedFiles">0</div>
            <div class="stat-label">Failed</div>
          </div>
        </div>

        <div class="current-processing" id="currentProcessing" style="display: none;">
          <div class="processing-file">
            <div class="file-info">
              <span class="file-name" id="currentFileName">-</span>
              <span class="file-size" id="currentFileSize">-</span>
            </div>
            <div class="progress-container">
              <div class="progress-bar">
                <div class="progress-fill" id="currentProgress" style="width: 0%;"></div>
              </div>
              <span class="progress-text" id="progressText">0%</span>
            </div>
          </div>
        </div>

        <div class="processing-queue" id="processingQueue">
          <h4>📋 Processing Queue</h4>
          <div class="queue-list" id="queueList">
            <div class="empty-queue">No files in queue</div>
          </div>
        </div>

        <div class="rag-status" id="ragStatus">
          <h4>⚙️ RAG Configuration</h4>
          <div class="rag-config-display" id="ragConfigDisplay">
            <div class="config-loading">Loading configuration...</div>
          </div>
        </div>
      </div>
    `;

    this.updateStatDisplay();
  }

  // Bind event listeners
  bindEvents() {
    // Refresh button
    const refreshBtn = document.getElementById('refreshStatus');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refreshStatus());
    }

    // Clear completed button
    const clearBtn = document.getElementById('clearCompleted');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearCompleted());
    }

    // Processor status updates
    if (this.processor) {
      this.processor.onStatusUpdate((event, data) => {
        this.handleStatusUpdate(event, data);
      });
    }
  }

  // Handle status updates from processor
  handleStatusUpdate(event, data) {
    switch (event) {
      case 'config_loaded':
        this.updateRagConfig(data);
        break;
      case 'queue_updated':
        this.updateQueueDisplay(data.queue);
        this.updateStatDisplay();
        break;
      case 'batch_started':
        console.log('Batch processing started:', data);
        this.updateStatDisplay();
        break;
      case 'file_started':
        this.updateCurrentProcessing(data);
        this.updateStatDisplay();
        break;
      case 'file_completed':
        this.updateFileStatus(data);
        this.updateStatDisplay();
        break;
      case 'file_failed':
        this.updateFileStatus(data);
        this.updateStatDisplay();
        break;
      case 'batch_completed':
        this.hideCurrentProcessing();
        this.updateStatDisplay();
        this.showBatchResult(data);
        break;
      case 'queue_cleared':
        this.updateQueueDisplay(data.queue);
        this.updateStatDisplay();
        break;
    }
  }

  // Update statistics display
  updateStatDisplay() {
    if (!this.processor) return;

    const stats = this.processor.getStats();
    
    document.getElementById('totalFiles').textContent = stats.total;
    document.getElementById('queuedFiles').textContent = stats.queued;
    document.getElementById('processingFiles').textContent = stats.processing;
    document.getElementById('completedFiles').textContent = stats.completed;
    document.getElementById('failedFiles').textContent = stats.failed;
  }

  // Update current processing display
  updateCurrentProcessing(fileItem) {
    const currentDiv = document.getElementById('currentProcessing');
    const fileName = document.getElementById('currentFileName');
    const fileSize = document.getElementById('currentFileSize');
    
    if (currentDiv && fileName && fileSize) {
      currentDiv.style.display = 'block';
      fileName.textContent = fileItem.file.name;
      fileSize.textContent = this.formatFileSize(fileItem.file.size);
      
      // Start progress animation
      this.animateProgress(fileItem);
    }
  }

  // Hide current processing display
  hideCurrentProcessing() {
    const currentDiv = document.getElementById('currentProcessing');
    if (currentDiv) {
      currentDiv.style.display = 'none';
    }
  }

  // Animate progress bar (simulated progress for now)
  animateProgress(fileItem) {
    const progressFill = document.getElementById('currentProgress');
    const progressText = document.getElementById('progressText');
    
    if (!progressFill || !progressText) return;

    let progress = 0;
    const interval = setInterval(() => {
      if (fileItem.status !== 'processing') {
        clearInterval(interval);
        if (fileItem.status === 'completed') {
          progressFill.style.width = '100%';
          progressText.textContent = '100%';
        }
        return;
      }

      progress += Math.random() * 10;
      progress = Math.min(progress, 95); // Never reach 100% until actually complete
      
      progressFill.style.width = `${progress}%`;
      progressText.textContent = `${Math.round(progress)}%`;
    }, 500);
  }

  // Update queue display
  updateQueueDisplay(queue) {
    const queueList = document.getElementById('queueList');
    if (!queueList) return;

    if (queue.length === 0) {
      queueList.innerHTML = '<div class="empty-queue">No files in queue</div>';
      return;
    }

    queueList.innerHTML = queue.map(item => `
      <div class="queue-item ${this.escapeText(item.status)}" data-id="${this.escapeText(item.id)}">
        <div class="queue-file-info">
          <span class="queue-file-name">${this.escapeText(item.file.name)}</span>
          <span class="queue-file-size">${this.escapeText(this.formatFileSize(item.file.size))}</span>
        </div>
        <div class="queue-status">
          <span class="status-badge ${this.escapeText(item.status)}">${this.getStatusIcon(item.status)} ${this.escapeText(item.status)}</span>
          ${item.error ? `<span class="error-msg">${this.escapeText(item.error)}</span>` : ''}
        </div>
      </div>
    `).join('');
  }

  // Update file status in queue
  updateFileStatus(fileItem) {
    const queueItem = document.querySelector(`[data-id="${fileItem.id}"]`);
    if (queueItem) {
      queueItem.className = `queue-item ${fileItem.status}`;
      const statusBadge = queueItem.querySelector('.status-badge');
      if (statusBadge) {
        statusBadge.textContent = `${this.getStatusIcon(fileItem.status)} ${fileItem.status}`;
        statusBadge.className = `status-badge ${fileItem.status}`;
      }
      
      if (fileItem.error) {
        const errorMsg = queueItem.querySelector('.error-msg');
        if (errorMsg) {
          errorMsg.textContent = fileItem.error;
        } else {
          const statusDiv = queueItem.querySelector('.queue-status');
          const error = document.createElement('span');
          error.className = 'error-msg';
          error.textContent = String(fileItem.error);
          statusDiv.appendChild(error);
        }
      }
    }
  }

  // Update RAG configuration display
  updateRagConfig(config) {
    const configDisplay = document.getElementById('ragConfigDisplay');
    if (!configDisplay) return;

    configDisplay.innerHTML = `
      <div class="rag-config-item">
        <span class="config-label">Chunk Strategy:</span>
        <span class="config-value">${this.escapeText(config.chunkStrategy)}</span>
      </div>
      <div class="rag-config-item">
        <span class="config-label">Chunk Size:</span>
        <span class="config-value">${this.escapeText(config.chunkSize)}</span>
      </div>
      <div class="rag-config-item">
        <span class="config-label">Chunk Overlap:</span>
        <span class="config-value">${this.escapeText(config.chunkOverlap)}</span>
      </div>
      <div class="rag-config-item">
        <span class="config-label">Multimodal:</span>
        <span class="config-value">${config.multimodal ? 'Enabled' : 'Disabled'}</span>
      </div>
      <div class="rag-config-item">
        <span class="config-label">Embedding Model:</span>
        <span class="config-value">${this.escapeText(config.embeddingModel)}</span>
      </div>
    `;
  }

  // Show batch completion result
  showBatchResult(data) {
    const notification = document.createElement('div');
    notification.className = 'batch-notification';
    notification.innerHTML = `
      <div class="notification-content">
        <h4>✅ Batch Processing Completed</h4>
        <p>Processed: ${this.escapeText(data.processed)} files</p>
        ${data.failed > 0 ? `<p>Failed: ${this.escapeText(data.failed)} files</p>` : ''}
      </div>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.remove();
    }, 5000);
  }

  // Utility methods
  escapeText(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"'`]/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
    })[ch]);
  }

  getStatusIcon(status) {
    switch (status) {
      case 'queued': return '⏳';
      case 'processing': return '⚙️';
      case 'completed': return '✅';
      case 'failed': return '❌';
      default: return '❓';
    }
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Manual refresh
  refreshStatus() {
    this.updateStatDisplay();
    if (this.processor) {
      this.updateQueueDisplay(this.processor.processingQueue);
    }
  }

  // Clear completed files
  clearCompleted() {
    if (this.processor) {
      this.processor.clearProcessed();
    }
  }
}

const INGEST_STATUS_LABELS = {
  en: {
    'status.queued': 'Queued',
    'status.preflight': 'Checking pages',
    'status.parsing': 'Parsing',
    'status.checking': 'Checking quality',
    'status.chunking': 'Chunking',
    'status.embedding': 'Embedding',
    'status.ready': 'Ready',
    'status.failed': 'Failed',
    'status.quarantined': 'Quarantined',
    'status.needs_review': 'Needs review',
    'status.skipped_duplicate': 'Skipped, unchanged',
    'status.dryRunReady': 'Dry run complete',
    'status.deleteReady': 'Removed',
    'status.provisional': 'Searchable, still improving',
    'reason.budget_exhausted': 'the premium page budget is used up',
    'reason.over_page_cap': 'more premium pages than the per-document cap',
    'reason.cloud_not_allowed': 'cloud parsing is not allowed',
    'reason.batch_budget_exhausted': 'the backfill budget is used up',
    'reason.lease_expired': 'the worker stopped responding',
    'reason.ocr_failed': 'text recognition failed',
    'reason.transient': 'a temporary error',
    'reason.result_unreadable': 'the parser result could not be read',
    'action.retry': 'Retry job',
    'action.retryAria': 'Retry the job for {file}',
    'action.retrying': 'Retrying…',
    'action.retried': '{file} is queued again.',
    'error.signIn':
      'Admin sign-in required. Sign in to the main myRAG app at {appUrl} (Settings → Admin tab), then reload the Config UI.',
    'error.unavailable': 'Service temporarily unavailable. Please retry in a moment.',
    'error.network': "Can't reach the Config UI server. Check that it is running, then reload.",
    'error.notFound': 'This job no longer exists in this workspace. The list has been refreshed.',
    'error.notRetryable':
      "This job can't be retried. Only failed or needs-review jobs can be retried, by an owner or admin of the workspace. The list has been refreshed.",
    'error.generic': 'Request failed ({status}).',
    'monitor.needsReview': 'Needs review: {reason}',
    'monitor.failed': 'Failed: {reason}',
    'monitor.quarantined': 'Quarantined. Review it under RAG administration, Quarantine.',
    'monitor.duplicate': 'Already in the knowledge base, unchanged.',
    'monitor.retrying': 'Status unavailable, trying again.',
    'monitor.stopped': 'Status checks stopped. Follow this upload in RAG administration, Ingestion.',
    'monitor.notFound': "This upload's job is not in the selected workspace.",
    'monitor.announce': '{file}: {status}',
    'monitor.log.queued': '{file} queued for ingestion',
    'monitor.log.ready': '{file} is ready',
    'monitor.log.failed': '{file} failed: {reason}',
    'monitor.log.needsReview': '{file} needs review: {reason}',
  },
  zh: {
    'status.queued': '排队中',
    'status.preflight': '页面预检中',
    'status.parsing': '解析中',
    'status.checking': '质量检查中',
    'status.chunking': '切块中',
    'status.embedding': '向量化中',
    'status.ready': '已就绪',
    'status.failed': '失败',
    'status.quarantined': '已隔离',
    'status.needs_review': '待审核',
    'status.skipped_duplicate': '已跳过（未变化）',
    'status.dryRunReady': '试运行完成',
    'status.deleteReady': '已移除',
    'status.provisional': '可检索，仍在优化',
    'reason.budget_exhausted': '高级解析预算已用完',
    'reason.over_page_cap': '高级页数超过单文档上限',
    'reason.cloud_not_allowed': '不允许云端解析',
    'reason.batch_budget_exhausted': '回填预算已用完',
    'reason.lease_expired': '工作进程无响应',
    'reason.ocr_failed': '文字识别失败',
    'reason.transient': '临时错误',
    'reason.result_unreadable': '无法读取解析结果',
    'action.retry': '重试任务',
    'action.retryAria': '重试 {file} 的任务',
    'action.retrying': '正在重试…',
    'action.retried': '{file} 已重新排队。',
    'error.signIn':
      '需要管理员登录。请在 {appUrl} 登录 myRAG 主应用（设置 → 管理员标签页），然后重新加载 Config UI。',
    'error.unavailable': '服务暂时不可用，请稍后重试。',
    'error.network': '无法连接 Config UI 服务器。请确认它正在运行，然后重新加载。',
    'error.notFound': '此任务在当前工作区中已不存在，列表已刷新。',
    'error.notRetryable':
      '无法重试此任务。只有失败或待审核的任务可以重试，且需由工作区所有者或管理员操作。列表已刷新。',
    'error.generic': '请求失败（{status}）。',
    'monitor.needsReview': '待审核：{reason}',
    'monitor.failed': '失败：{reason}',
    'monitor.quarantined': '已隔离。请在“RAG 管理 → 隔离区”中审核。',
    'monitor.duplicate': '知识库中已有相同内容，未变化。',
    'monitor.retrying': '暂时无法获取状态，正在再次尝试。',
    'monitor.stopped': '已停止状态检查。请在“RAG 管理 → 文档入库”中查看此上传。',
    'monitor.notFound': '当前工作区中找不到此上传的任务。',
    'monitor.announce': '{file}：{status}',
    'monitor.log.queued': '{file} 已排队入库',
    'monitor.log.ready': '{file} 已就绪',
    'monitor.log.failed': '{file} 失败：{reason}',
    'monitor.log.needsReview': '{file} 待审核：{reason}',
  },
  it: {
    'status.queued': 'In coda',
    'status.preflight': 'Verifica pagine',
    'status.parsing': 'Parsing in corso',
    'status.checking': 'Controllo qualità',
    'status.chunking': 'Suddivisione',
    'status.embedding': 'Embedding in corso',
    'status.ready': 'Pronto',
    'status.failed': 'Non riuscito',
    'status.quarantined': 'In quarantena',
    'status.needs_review': 'Da rivedere',
    'status.skipped_duplicate': 'Saltato, invariato',
    'status.dryRunReady': 'Prova completata',
    'status.deleteReady': 'Rimosso',
    'status.provisional': 'Ricercabile, in miglioramento',
    'reason.budget_exhausted': 'il budget di pagine premium è esaurito',
    'reason.over_page_cap': 'più pagine premium del limite per documento',
    'reason.cloud_not_allowed': 'il parsing cloud non è consentito',
    'reason.batch_budget_exhausted': 'il budget del backfill è esaurito',
    'reason.lease_expired': 'il worker ha smesso di rispondere',
    'reason.ocr_failed': 'riconoscimento del testo non riuscito',
    'reason.transient': 'un errore temporaneo',
    'reason.result_unreadable': 'il risultato del parser è illeggibile',
    'action.retry': 'Riprova job',
    'action.retryAria': 'Riprova il job per {file}',
    'action.retrying': 'Nuovo tentativo…',
    'action.retried': '{file} è di nuovo in coda.',
    'error.signIn':
      "Accesso amministratore richiesto. Accedi all'app myRAG principale su {appUrl} (Impostazioni → scheda Admin), poi ricarica la Config UI.",
    'error.unavailable': 'Servizio temporaneamente non disponibile. Riprova tra poco.',
    'error.network': 'Impossibile raggiungere il server della Config UI. Verifica che sia in esecuzione, poi ricarica.',
    'error.notFound': 'Questo job non esiste più in questo spazio di lavoro. L\'elenco è stato aggiornato.',
    'error.notRetryable':
      'Impossibile riprovare questo job. Solo i job non riusciti o da rivedere possono essere riprovati, da un proprietario o amministratore dello spazio di lavoro. L\'elenco è stato aggiornato.',
    'error.generic': 'Richiesta non riuscita ({status}).',
    'monitor.needsReview': 'Da rivedere: {reason}',
    'monitor.failed': 'Non riuscito: {reason}',
    'monitor.quarantined': 'In quarantena. Controllalo in Amministrazione RAG, Quarantena.',
    'monitor.duplicate': 'Già presente nella knowledge base, invariato.',
    'monitor.retrying': 'Stato non disponibile, nuovo tentativo in corso.',
    'monitor.stopped': 'Controlli di stato interrotti. Segui questo caricamento in Amministrazione RAG, Acquisizione.',
    'monitor.notFound': 'Il job di questo caricamento non è nello spazio di lavoro selezionato.',
    'monitor.announce': '{file}: {status}',
    'monitor.log.queued': '{file} in coda per l\'acquisizione',
    'monitor.log.ready': '{file} è pronto',
    'monitor.log.failed': '{file} non riuscito: {reason}',
    'monitor.log.needsReview': '{file} da rivedere: {reason}',
  },
};

const INGEST_TERMINAL_STATUSES = new Set(['ready', 'failed', 'needs_review', 'quarantined', 'skipped_duplicate']);
const INGEST_NON_TERMINAL = new Set(['queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding']);

function fillIngestTemplate(text, vars) {
  if (!text || !vars) return text;
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(String(value ?? ''));
  }
  return out;
}

function ingestLabel(key, locale, vars) {
  const loc = locale === 'zh' || locale === 'it' ? locale : 'en';
  const table = INGEST_STATUS_LABELS[loc] || INGEST_STATUS_LABELS.en;
  const text = table[key] || INGEST_STATUS_LABELS.en[key] || key;
  return fillIngestTemplate(text, vars);
}

function localizedReason(code, locale) {
  if (!code) return '';
  const key = `reason.${code}`;
  const translated = ingestLabel(key, locale);
  return translated === key ? String(code) : translated;
}

function nextIngestPollDelay(elapsedMs, backoffStep) {
  if (elapsedMs < 60_000) return 2000;
  if (backoffStep === 0) return 5000;
  if (backoffStep === 1) return 10_000;
  if (backoffStep === 2) return 20_000;
  return 30_000;
}

function ingestJobStatusView(job, locale) {
  const status = job && job.status ? String(job.status) : 'queued';
  const terminal = INGEST_TERMINAL_STATUSES.has(status);
  const provisional = job && job.provisional === true && !terminal;

  let labelKey = `status.${status}`;
  let icon = 'bi-hourglass';
  let colorClass = 'text-base-content/70';
  let showRetry = false;

  if (provisional) {
    labelKey = 'status.provisional';
    icon = 'bi-search';
    colorClass = 'text-info';
  } else if (job && job.kind === 'dry_run' && status === 'ready') {
    labelKey = 'status.dryRunReady';
    icon = 'bi-clipboard-check';
    colorClass = 'text-base-content/70';
  } else if (status === 'needs_review') {
    const reason = localizedReason(job.needs_review_reason, locale) || job.needs_review_reason || '';
    return {
      label: ingestLabel('monitor.needsReview', locale, { reason }),
      labelKey: 'monitor.needsReview',
      icon: 'bi-exclamation-triangle',
      colorClass: 'text-warning',
      terminal: true,
      showRetry: true,
    };
  } else if (status === 'failed') {
    const reason = localizedReason(job.error_class, locale) || job.error_class || '';
    return {
      label: ingestLabel('monitor.failed', locale, { reason }),
      labelKey: 'monitor.failed',
      icon: 'bi-x-octagon',
      colorClass: 'text-error',
      terminal: true,
      showRetry: true,
    };
  } else if (status === 'ready') {
    icon = 'bi-check-circle';
    colorClass = 'text-success';
  } else if (status === 'quarantined') {
    return {
      label: ingestLabel('monitor.quarantined', locale),
      labelKey: 'monitor.quarantined',
      icon: 'bi-shield-exclamation',
      colorClass: 'text-warning',
      terminal: true,
      showRetry: false,
    };
  } else if (status === 'skipped_duplicate') {
    return {
      label: ingestLabel('monitor.duplicate', locale),
      labelKey: 'monitor.duplicate',
      icon: 'bi-skip-forward',
      colorClass: 'text-base-content/70',
      terminal: true,
      showRetry: false,
    };
  } else if (INGEST_NON_TERMINAL.has(status)) {
    icon = 'bi-arrow-repeat';
    colorClass = 'text-info';
  }

  return {
    label: ingestLabel(labelKey, locale),
    labelKey,
    icon,
    colorClass,
    terminal,
    showRetry: showRetry && terminal,
  };
}

if (typeof window !== 'undefined') {
  window.DocumentStatusMonitor = DocumentStatusMonitor;
  window.INGEST_STATUS_LABELS = INGEST_STATUS_LABELS;
  window.ingestLabel = ingestLabel;
  window.ingestJobStatusView = ingestJobStatusView;
  window.nextIngestPollDelay = nextIngestPollDelay;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DocumentStatusMonitor,
    INGEST_STATUS_LABELS,
    ingestLabel,
    ingestJobStatusView,
    nextIngestPollDelay,
  };
}

console.log('Document status monitor script loaded');