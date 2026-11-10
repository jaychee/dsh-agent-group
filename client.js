/**
 * Agent Squad — client half (settings page).
 *
 * Registers one `settings.section` page (id `agent-squad`) that edits the
 * profile-level squad settings over the host's loopback HTTP routes. All copy
 * is inline (zh/en) and switches with the host locale; nothing is fetched
 * from an HTTP dictionary.
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-squad',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const zh = {
      title: '智能体小队',
      subtitle: '配置三个小队成员与 worktree 目录。保存后立即对下一次派单生效。',
      flowTitle: '执行流程',
      flowLead: 'Lead（当前会话）',
      flowExternal: '外部一次性',
      flowLocal: '本地可续跑',
      flowTeam: 'Team 可续跑',
      flowReview: 'review / rework 回路',
      agentsTitle: '成员',
      worktreeTitle: 'Worktree',
      worktreeDirectory: '目录（仓库相对路径）',
      worktreeHint: 'squad worktree 会创建在 <仓库>/<此目录>/squad-<任务号>，禁止绝对路径与 ..。',
      fieldId: 'ID（只读）',
      fieldName: '名称',
      fieldRole: '角色',
      fieldExecutor: '执行方式',
      fieldModel: '模型 / Provider',
      fieldDescription: '描述',
      roleBrain: 'brain（方案与验收）',
      roleWorker: 'worker（实现与测试）',
      executorExternal: 'external · 外部一次性',
      executorLocal: 'local · 本地固定模型，可续跑',
      executorTeam: 'team · 进程内队友，可续跑',
      modelPlaceholderLocal: '选择 provider/model',
      modelPlaceholderExternal: '选择外部 provider',
      modelUnavailableGroup: '（该 provider 暂不可用）',
      save: '保存',
      saving: '保存中…',
      resetDefaults: '恢复出厂默认',
      discard: '放弃修改',
      resetConfirm: '将出厂默认写入草稿（不落盘），确认继续？',
      discardConfirm: '放弃当前未保存的修改？',
      dirtyHint: '有未保存的修改。',
      reloadServer: '改用服务器版本',
      reloadConfirm: '放弃当前草稿并改用服务器版本？',
      saveFailed: '保存失败',
      conflictTitle: '设置已在别处更新（版本冲突，草稿已保留）。',
      loadFailed: '设置加载失败。',
      modelsFailed: '模型列表加载失败。',
      retry: '重试',
      partialModels: '部分模型提供方暂时不可用。',
      unsavedWarning: 'Agent Squad 设置有未保存的修改',
      errorFor: (code) =>
        ({
          NAME_REQUIRED: '名称不能为空',
          NAME_DUPLICATE: '名称重复',
          BRAIN_REQUIRED: '至少需要一个 brain',
          ROLE_INVALID: '角色非法',
          EXECUTOR_INVALID: '执行方式非法',
          MODEL_REQUIRED: '必须选择外部 provider',
          MODEL_INVALID: '模型必须形如 provider/model',
          MODEL_NOT_FOUND: '模型不在当前模型列表内',
          MODEL_MUST_BE_EMPTY: '该执行方式下模型须为空',
          PROVIDER_NOT_REGISTERED: '外部 provider 未注册',
          DIRECTORY_REQUIRED: '目录不能为空',
          DIRECTORY_ABSOLUTE: '禁止绝对路径',
          DIRECTORY_TRAVERSAL: '禁止 . 或 .. 段',
          DIRECTORY_INVALID: '目录非法',
          ID_READONLY: 'ID 只读',
          UNKNOWN_FIELD: '存在未知字段',
          AGENT_COUNT: '成员数必须为 3',
          DESCRIPTION_INVALID: '描述必须是字符串',
          INVALID_TYPE: '字段类型非法',
        })[code] || '无效的值',
    }

    const en = {
      title: 'Agent Squad',
      subtitle: 'Configure the three squad members and the worktree directory. Saves apply to the next dispatch.',
      flowTitle: 'Pipeline',
      flowLead: 'Lead (this session)',
      flowExternal: 'external · one-shot',
      flowLocal: 'local · continuable',
      flowTeam: 'team · continuable',
      flowReview: 'review / rework loop',
      agentsTitle: 'Members',
      worktreeTitle: 'Worktree',
      worktreeDirectory: 'Directory (repository-relative)',
      worktreeHint: 'Squad worktrees are created at <repo>/<directory>/squad-<task>; absolute paths and .. are rejected.',
      fieldId: 'ID (read-only)',
      fieldName: 'Name',
      fieldRole: 'Role',
      fieldExecutor: 'Executor',
      fieldModel: 'Model / provider',
      fieldDescription: 'Description',
      roleBrain: 'brain (design & review)',
      roleWorker: 'worker (implement & test)',
      executorExternal: 'external · one-shot provider',
      executorLocal: 'local · pinned model, continuable',
      executorTeam: 'team · in-process teammate, continuable',
      modelPlaceholderLocal: 'Choose provider/model',
      modelPlaceholderExternal: 'Choose an external provider',
      modelUnavailableGroup: '(provider unavailable)',
      save: 'Save',
      saving: 'Saving…',
      resetDefaults: 'Reset to defaults',
      discard: 'Discard changes',
      resetConfirm: 'Load factory defaults into the draft (not saved). Continue?',
      discardConfirm: 'Discard unsaved changes?',
      dirtyHint: 'You have unsaved changes.',
      reloadServer: 'Use the server version',
      reloadConfirm: 'Discard the current draft and use the server version?',
      saveFailed: 'Save failed',
      conflictTitle: 'Settings changed elsewhere (revision conflict; your draft is kept).',
      loadFailed: 'Failed to load settings.',
      modelsFailed: 'Failed to load models.',
      retry: 'Retry',
      partialModels: 'Some model providers are currently unavailable.',
      unsavedWarning: 'Agent Squad settings have unsaved changes',
      errorFor: (code) =>
        ({
          NAME_REQUIRED: 'Name is required',
          NAME_DUPLICATE: 'Duplicate name',
          BRAIN_REQUIRED: 'At least one brain is required',
          ROLE_INVALID: 'Invalid role',
          EXECUTOR_INVALID: 'Invalid executor',
          MODEL_REQUIRED: 'An external provider is required',
          MODEL_INVALID: 'Model must look like provider/model',
          MODEL_NOT_FOUND: 'Model is not in the catalog',
          MODEL_MUST_BE_EMPTY: 'Model must stay empty for this executor',
          PROVIDER_NOT_REGISTERED: 'External provider is not registered',
          DIRECTORY_REQUIRED: 'Directory is required',
          DIRECTORY_ABSOLUTE: 'Absolute paths are rejected',
          DIRECTORY_TRAVERSAL: '"." or ".." segments are rejected',
          DIRECTORY_INVALID: 'Invalid directory',
          ID_READONLY: 'ID is read-only',
          UNKNOWN_FIELD: 'Unknown field',
          AGENT_COUNT: 'Exactly 3 members are required',
          DESCRIPTION_INVALID: 'Description must be a string',
          INVALID_TYPE: 'Invalid field type',
        })[code] || 'Invalid value',
    }

    /** Plugin context, set by apply() so components can read the host locale. */
    let pluginCtx = null

    /**
     * Factory-level edit session (R06): the draft, baseline, defaults, save
     * state and conflict live outside the component, survive unmounting and
     * are observed through a tiny store. Only the first mount (or an explicit
     * reload) fetches; a PUT in flight is never aborted by unmount so its
     * result still lands in the session.
     */
    const session = {
      loaded: false,
      baseline: null,
      defaults: null,
      draft: null,
      conflict: null,
      saving: false,
      fieldErrors: {},
      notice: null,
      requestSeq: 0,
      revision: 0,
    }
    const sessionListeners = new Set()
    const updateSession = (patch) => {
      Object.assign(session, patch)
      session.revision += 1
      for (const listener of sessionListeners) listener()
    }

    function pickLocale() {
      const getSnapshot = () => {
        try {
          return pluginCtx?.locale?.getLocale?.()?.active === 'en' ? 'en' : 'zh'
        } catch {
          return 'zh'
        }
      }
      if (!pluginCtx?.locale?.subscribe) return getSnapshot()
      return React.useSyncExternalStore((cb) => pluginCtx.locale.subscribe(cb), getSnapshot, getSnapshot)
    }

    const CSS = `
.asq-page{max-width:860px;display:flex;flex-direction:column;gap:24px;color:var(--dsw-alias-text-primary)}
.asq-title{margin:0;font-size:20px;font-weight:600}
.asq-sub{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px}
.asq-section{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-module)}
.asq-sectionTitle{margin:0;font-size:14px;font-weight:600}
.asq-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px}
.asq-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.asq-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.asq-label{font-size:12px;color:var(--dsw-alias-label-primary)}
.asq-input,.asq-select,.asq-textarea{font:inherit;font-size:13px;color:var(--dsw-alias-text-primary);background:var(--dsw-alias-bg-input);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:4px 8px;min-width:0}
.asq-textarea{resize:vertical;min-height:56px}
.asq-readonly{opacity:.7}
.asq-error{color:var(--dsw-alias-danger-text,#e5484d);font-size:12px}
.asq-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}
.asq-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.asq-btn{font:inherit;font-size:13px;padding:6px 14px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-text-primary);cursor:pointer}
.asq-btn:disabled{opacity:.5;cursor:not-allowed}
.asq-banner{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px 12px;font-size:13px}
.asq-banner-error{color:var(--dsw-alias-danger-text,#e5484d)}
.asq-svg{width:100%;height:auto;display:block}
`

    function Topology({ draft, t }) {
      const mode = (agent) =>
        agent.executor === 'external' ? t.flowExternal : agent.executor === 'local' ? t.flowLocal : t.flowTeam
      const nodes = draft.agents
      const labels = nodes.map((agent) => `${agent.displayName} · ${agent.role}`)
      const sub = nodes.map((agent) => mode(agent))
      return h(
        'svg',
        {
          className: 'asq-svg',
          viewBox: '0 0 640 190',
          role: 'img',
          'aria-label': t.flowTitle,
        },
        h('defs', null, h('marker', {
          id: 'asq-arrow', markerWidth: '8', markerHeight: '8', refX: '7', refY: '4',
          orient: 'auto', markerUnits: 'strokeWidth',
        }, h('path', { d: 'M0,0 L8,4 L0,8 z', fill: 'var(--dsw-alias-label-secondary)' }))),
        // Lead node
        h('rect', { x: 16, y: 65, width: 130, height: 60, rx: 8, fill: 'var(--dsw-alias-interactive-bg-hover)', stroke: 'var(--dsw-alias-border-l2)' }),
        h('text', { x: 81, y: 90, textAnchor: 'middle', fontSize: 13, fill: 'var(--dsw-alias-text-primary)' }, t.flowLead),
        h('text', { x: 81, y: 108, textAnchor: 'middle', fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' }, 'design → implement → review'),
        // Agent nodes
        ...nodes.map((agent, index) => {
          const y = 20 + index * 60
          const label = `${agent.displayName} (${agent.id})`
          return h('g', { key: agent.id },
            h('path', { d: `M146,95 C200,95 210,${y + 22} 246,${y + 22}`, fill: 'none', stroke: 'var(--dsw-alias-label-secondary)', markerEnd: 'url(#asq-arrow)' }),
            h('rect', { x: 250, y, width: 230, height: 44, rx: 8, fill: 'var(--dsw-alias-bg-module)', stroke: 'var(--dsw-alias-border-l2)' }),
            h('text', { x: 365, y: y + 18, textAnchor: 'middle', fontSize: 12, fill: 'var(--dsw-alias-text-primary)' }, label),
            h('text', { x: 365, y: y + 33, textAnchor: 'middle', fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' }, sub[index]),
          )
        }),
        // review / rework loop
        h('path', { d: 'M480,95 C540,95 540,30 365,30 C300,30 260,40 250,42', fill: 'none', stroke: 'var(--dsw-alias-label-secondary)', strokeDasharray: '4 3', markerEnd: 'url(#asq-arrow)' }),
        h('text', { x: 545, y: 62, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' }, t.flowReview),
      )
    }

    function AgentCard({ agent, index, draft, setDraft, models, fieldErrors, t, disabled = false }) {
      const prefix = `agents.${agent.id}`
      const update = (patch) => {
        const agents = draft.agents.map((entry, i) => (i === index ? { ...entry, ...patch } : entry))
        setDraft({ ...draft, agents })
      }
      const err = (field) => fieldErrors[`${prefix}.${field}`]
      const modelValue = agent.model ?? ''
      return h(
        'div',
        { className: 'asq-card' },
        h('div', { className: 'asq-field' },
          h('label', { className: 'asq-label' }, `${t.fieldId}: ${agent.id}`)),
        h('div', { className: 'asq-field' },
          h('label', { className: 'asq-label', htmlFor: `asq-${agent.id}-name` }, t.fieldName),
          h('input', {
            id: `asq-${agent.id}-name`, className: 'asq-input', value: agent.displayName,
            disabled,
            onChange: (event) => update({ displayName: event.target.value }),
            'aria-invalid': err('displayName') ? 'true' : undefined,
          }),
          err('displayName') && h('span', { className: 'asq-error', role: 'alert' }, t.errorFor(err('displayName')))),
        h('div', { className: 'asq-field' },
          h('label', { className: 'asq-label', htmlFor: `asq-${agent.id}-role` }, t.fieldRole),
          h('select', {
            id: `asq-${agent.id}-role`, className: 'asq-select', value: agent.role,
            disabled,
            onChange: (event) => update({ role: event.target.value }),
          },
            h('option', { value: 'brain' }, t.roleBrain),
            h('option', { value: 'worker' }, t.roleWorker),
          ),
          err('role') && h('span', { className: 'asq-error', role: 'alert' }, t.errorFor(err('role')))),
        h('div', { className: 'asq-field' },
          h('label', { className: 'asq-label', htmlFor: `asq-${agent.id}-executor` }, t.fieldExecutor),
          h('select', {
            id: `asq-${agent.id}-executor`, className: 'asq-select', value: agent.executor,
            disabled,
            onChange: (event) => update({ executor: event.target.value, model: event.target.value === 'team' ? '' : agent.model }),
          },
            h('option', { value: 'external' }, t.executorExternal),
            h('option', { value: 'local' }, t.executorLocal),
            h('option', { value: 'team' }, t.executorTeam),
          ),
          err('executor') && h('span', { className: 'asq-error', role: 'alert' }, t.errorFor(err('executor')))),
        agent.executor !== 'team' &&
          h('div', { className: 'asq-field' },
            h('label', { className: 'asq-label', htmlFor: `asq-${agent.id}-model` }, t.fieldModel),
            agent.executor === 'local'
              ? h('select', {
                  id: `asq-${agent.id}-model`, className: 'asq-select', value: modelValue,
                  disabled,
                  onChange: (event) => update({ model: event.target.value }),
                  'aria-invalid': err('model') ? 'true' : undefined,
                },
                  h('option', { value: '' }, t.modelPlaceholderLocal),
                  ...(models?.groups ?? []).map((group) =>
                    h('optgroup', { key: group.provider, label: group.error ? `${group.provider} ${t.modelUnavailableGroup}` : group.label },
                      group.models.map((model) => h('option', { key: model.value, value: model.value }, model.id)),
                    )),
                  modelValue && !(models?.groups ?? []).some((g) => g.models.some((m) => m.value === modelValue))
                    ? h('optgroup', { label: t.modelUnavailableGroup }, h('option', { value: modelValue }, modelValue))
                    : null,
                )
              : h('select', {
                  id: `asq-${agent.id}-model`, className: 'asq-select', value: modelValue,
                  disabled,
                  onChange: (event) => update({ model: event.target.value }),
                  'aria-invalid': err('model') ? 'true' : undefined,
                },
                  h('option', { value: '' }, t.modelPlaceholderExternal),
                  ...(models?.externalProviders ?? []).map((provider) =>
                    h('option', { key: provider.id, value: provider.id }, provider.label)),
                  modelValue && !(models?.externalProviders ?? []).some((p) => p.id === modelValue)
                    ? h('option', { value: modelValue }, modelValue)
                    : null,
                ),
            err('model') && h('span', { className: 'asq-error', role: 'alert' }, t.errorFor(err('model')))),
        h('div', { className: 'asq-field' },
          h('label', { className: 'asq-label', htmlFor: `asq-${agent.id}-description` }, t.fieldDescription),
          h('textarea', {
            id: `asq-${agent.id}-description`, className: 'asq-textarea', value: agent.description,
            disabled,
            onChange: (event) => update({ description: event.target.value }),
          })),
      )
    }

    function SettingsPage() {
      const styleRef = React.useRef(null)
      React.useEffect(() => {
        const element = document.createElement('style')
        element.textContent = CSS
        document.head.appendChild(element)
        return () => element.remove()
      }, [])

      // Observe the factory-level session store (R06/R12): every mutation
      // re-renders, so a remounted page immediately reflects a PUT that was
      // still in flight (or has finished) while it was hidden.
      React.useSyncExternalStore(
        (callback) => {
          sessionListeners.add(callback)
          return () => sessionListeners.delete(callback)
        },
        () => session.revision,
        () => session.revision,
      )
      const { baseline, defaults, draft, conflict, saving, fieldErrors, notice } = session
      const setDraft = (value) => updateSession({ draft: value })
      const setFieldErrors = (value) => updateSession({ fieldErrors: value })
      const setNotice = (value) => updateSession({ notice: value })

      const [load, setLoad] = React.useState(session.loaded ? { status: 'ready' } : { status: 'loading' })
      const [modelsState, setModelsState] = React.useState({ status: 'loading' })

      const abortRef = React.useRef(null)
      const fetchSettings = React.useCallback(async () => {
        setLoad({ status: 'loading' })
        updateSession({ conflict: null })
        setFieldErrors({})
        const controller = new AbortController()
        abortRef.current = controller
        try {
          const response = await fetch('/agent-squad/settings', { signal: controller.signal })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          // Never clobber a preserved draft on remount (R06): only a first
          // load or an explicit reload replaces the draft.
          updateSession({
            baseline: body.settings,
            defaults: body.defaults,
            ...(session.draft
              ? {}
              : { draft: { agents: body.settings.agents, worktree: body.settings.worktree } }),
          })
          session.loaded = true
          setLoad({ status: 'ready' })
        } catch (error) {
          if (error?.name === 'AbortError') return
          setLoad({ status: 'error', message: error.message })
        }
      }, [])

      const fetchModels = React.useCallback(async () => {
        setModelsState({ status: 'loading' })
        try {
          const response = await fetch('/agent-squad/models')
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          setModelsState({ status: 'ready', ...body })
        } catch (error) {
          setModelsState({ status: 'error', message: error.message })
        }
      }, [])

      React.useEffect(() => {
        if (!session.loaded) fetchSettings()
        fetchModels()
        return () => abortRef.current?.abort()
      }, [fetchSettings, fetchModels])

      const language = pickLocale()
      const t = language === 'en' ? en : zh

      const dirty =
        baseline !== null &&
        draft !== null &&
        (JSON.stringify(draft.agents) !== JSON.stringify(baseline.agents) ||
          JSON.stringify(draft.worktree) !== JSON.stringify(baseline.worktree))

      React.useEffect(() => {
        if (!dirty) return undefined
        const handler = (event) => {
          event.preventDefault()
          event.returnValue = ''
        }
        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
      }, [dirty])

      const save = async () => {
        // Request generation: a completion from anything other than the
        // latest save is ignored, and the in-flight PUT is NOT aborted on
        // unmount — its result still lands in the session (R06/R12).
        const generation = ++session.requestSeq
        updateSession({ saving: true, conflict: null })
        setFieldErrors({})
        setNotice(null)
        const submitted = JSON.stringify(session.draft)
        try {
          const response = await fetch('/agent-squad/settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              expectedRevision: session.baseline.revision,
              agents: session.draft.agents,
              worktree: session.draft.worktree,
            }),
          })
          const body = await response.json().catch(() => ({}))
          if (generation !== session.requestSeq) return
          if (response.status === 409) {
            // Keep the draft; the banner offers a confirmed reload (R02).
            updateSession({ saving: false, conflict: body.settings ?? null })
            return
          }
          if (!response.ok) {
            const fields = body?.error?.fields ?? {}
            setFieldErrors(fields)
            if (Object.keys(fields).length === 0) {
              // No field errors (IO / catalog fault): show a visible notice (R12).
              setNotice({
                kind: 'error',
                text: `${t.saveFailed}：${body?.error?.message ?? `HTTP ${response.status}`}`,
              })
            }
            updateSession({ saving: false })
            return
          }
          // Adopt the server copy only when the draft still matches the
          // submitted snapshot; edits typed after submitting are preserved
          // (R12). The single comparison is against session.draft.
          const unchanged = JSON.stringify(session.draft) === submitted
          updateSession({
            baseline: body.settings,
            saving: false,
            ...(unchanged
              ? { draft: { agents: body.settings.agents, worktree: body.settings.worktree } }
              : {}),
          })
        } catch (error) {
          if (generation !== session.requestSeq) return
          setNotice({ kind: 'error', text: `${t.saveFailed}：${error.message}` })
          updateSession({ saving: false })
        }
      }

      const resetDefaults = () => {
        if (!window.confirm(t.resetConfirm)) return
        updateSession({
          draft: {
            agents: defaults.agents.map((a) => ({ ...a })),
            worktree: { ...defaults.worktree },
          },
          conflict: null,
        })
        setFieldErrors({})
      }

      const discard = () => {
        if (!window.confirm(t.discardConfirm)) return
        updateSession({
          draft: {
            agents: baseline.agents.map((a) => ({ ...a })),
            worktree: { ...baseline.worktree },
          },
          conflict: null,
        })
        setFieldErrors({})
        setNotice(null)
      }

      if (load.status === 'loading') return h('div', { className: 'asq-page' }, h('p', null, '…'))
      if (load.status === 'error') {
        return h('div', { className: 'asq-page' },
          h('h2', { className: 'asq-title' }, t.title),
          h('div', { className: 'asq-banner asq-banner-error', role: 'alert' }, t.loadFailed),
          h('button', { className: 'asq-btn', onClick: fetchSettings }, t.retry))
      }

      const models = modelsState.status === 'ready' ? modelsState : null
      return h(
        'div',
        { className: 'asq-page' },
        h('h2', { className: 'asq-title' }, t.title),
        h('p', { className: 'asq-sub' }, t.subtitle),
        h('div', { className: 'asq-section' },
          h('h3', { className: 'asq-sectionTitle' }, t.flowTitle),
          h(Topology, { draft, t })),
        h('div', { className: 'asq-section' },
          h('h3', { className: 'asq-sectionTitle' }, t.agentsTitle),
          h('div', { className: 'asq-cards' },
            draft.agents.map((agent, index) =>
              h(AgentCard, {
                key: agent.id, agent, index, draft, setDraft,
                models, fieldErrors, t, disabled: saving,
              }))),
          fieldErrors.agents && h('span', { className: 'asq-error', role: 'alert' }, t.errorFor(fieldErrors.agents))),
        h('div', { className: 'asq-section' },
          h('h3', { className: 'asq-sectionTitle' }, t.worktreeTitle),
          h('div', { className: 'asq-field' },
            h('label', { className: 'asq-label', htmlFor: 'asq-worktree-dir' }, t.worktreeDirectory),
            h('input', {
              id: 'asq-worktree-dir', className: 'asq-input',
              value: draft.worktree.directory,
              disabled: saving,
              onChange: (event) => setDraft({ ...draft, worktree: { directory: event.target.value } }),
              'aria-invalid': fieldErrors['worktree.directory'] ? 'true' : undefined,
            }),
            fieldErrors['worktree.directory'] &&
              h('span', { className: 'asq-error', role: 'alert' }, t.errorFor(fieldErrors['worktree.directory'])),
            h('span', { className: 'asq-hint' }, t.worktreeHint))),
        conflict !== null &&
          h('div', { className: 'asq-banner asq-banner-error', role: 'alert' },
            t.conflictTitle, ' ',
            h('button', {
              className: 'asq-btn', onClick: () => {
                if (!window.confirm(t.reloadConfirm)) return
                updateSession({
                  baseline: conflict,
                  draft: { agents: conflict.agents, worktree: conflict.worktree },
                  conflict: null,
                })
              },
            }, t.reloadServer)),
        notice && h('div', { className: `asq-banner ${notice.kind === 'error' ? 'asq-banner-error' : ''}`, role: 'alert' }, notice.text),
        modelsState.status === 'error' &&
          h('div', { className: 'asq-banner asq-banner-error', role: 'alert' },
            t.modelsFailed, ' ', h('button', { className: 'asq-btn', onClick: fetchModels }, t.retry)),
        models?.groups?.some((group) => group.error) && h('div', { className: 'asq-banner' }, t.partialModels),
        h('div', { className: 'asq-actions' },
          h('button', { className: 'asq-btn', onClick: save, disabled: saving }, saving ? t.saving : t.save),
          h('button', { className: 'asq-btn', onClick: resetDefaults, disabled: saving }, t.resetDefaults),
          h('button', { className: 'asq-btn', onClick: discard, disabled: (saving || (!dirty && conflict === null)) }, t.discard),
          dirty && h('span', { className: 'asq-hint' }, t.dirtyHint)),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        pluginCtx = ctx
        const localeOf = () => {
          try {
            return ctx.locale?.getLocale?.()?.active === 'en' ? en : zh
          } catch {
            return zh
          }
        }
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'agent-squad',
              order: 40,
              label: () => localeOf().title,
            },
            SettingsPage,
          ),
        )
      },
    }
  },
})
