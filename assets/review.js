(function (root, factory) {
  'use strict';
  const api = factory();
  // Node / test environment
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }
  // Browser
  root.DeckReview = api;
  api._autoInit();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Pure helpers (testable) ----------

  function deriveInitials(name) {
    if (!name) return '';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function buildPayload(state) {
    const json = {
      deck: state.deck,
      exported_at: state.exported_at,
      reviewer: state.reviewer,
      comments: state.comments,
    };
    const jsonStr = JSON.stringify(json, null, 2);

    const lines = [];
    lines.push(`**${state.deck} review — ${state.reviewer.name}**`);
    lines.push('');
    state.comments.forEach((c, i) => {
      const slideNum = parseInt((c.slide || '').replace(/[^0-9]/g, ''), 10) || (i + 1);
      const snippet = c.anchor && c.anchor.text_snippet;
      const truncatedSnippet = snippet ? `"${snippet.slice(0, 40)}${snippet.length > 40 ? '…' : ''}"` : null;
      const anchorLabel = (c.anchor && c.anchor.review_id) || truncatedSnippet || `pin ${c.id}`;
      lines.push(`${i + 1}. **Slide ${slideNum} · ${anchorLabel}** — ${c.body}`);
    });
    const md = lines.join('\n');

    return `=== deck.annotations.json ===\n${jsonStr}\n\n=== Review summary ===\n${md}\n`;
  }

  function parsePayload(text) {
    const m = String(text).match(/=== deck\.annotations\.json ===\s*([\s\S]*?)(?:\n===|$)/);
    if (!m) throw new Error('Missing JSON fence "=== deck.annotations.json ==="');
    return JSON.parse(m[1].trim());
  }

  // Parse a location-like object (real `location` in the browser, mock in tests)
  // and return { user, repo } if this is a github.io project page, else null.
  function detectGitHubRepo(loc) {
    if (!loc || !loc.hostname || !loc.pathname) return null;
    const m = loc.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return null;
    const user = m[1];
    const parts = loc.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null; // user root page, no repo
    return { user, repo: parts[0] };
  }

  // Build a GitHub issue creation URL with the payload prefilled in the body.
  // GitHub's URL prefill caps the full URL near 8000 chars; if the payload would
  // exceed that, we fall back to omitting the body and relying on clipboard paste.
  // Returns { url, prefilled: boolean }.
  function buildIssueUrl({ user, repo, deck, reviewerName, commentCount, payload, label }) {
    const title = `Review · ${deck} · ${reviewerName || 'Anonymous'} (${commentCount} comment${commentCount === 1 ? '' : 's'})`;
    const base = `https://github.com/${user}/${repo}/issues/new`;
    const withBody = `${base}?${new URLSearchParams({ title, labels: label || 'deck-review', body: payload }).toString()}`;
    if (withBody.length <= 8000) return { url: withBody, prefilled: true };
    // Too long - skip body, reviewer pastes manually.
    const noBody = `${base}?${new URLSearchParams({ title, labels: label || 'deck-review' }).toString()}`;
    return { url: noBody, prefilled: false };
  }

  // ---------- Activation + boot ----------

  function shouldActivate() {
    if (typeof window === 'undefined' || typeof location === 'undefined') return false;
    return new URLSearchParams(location.search).get('review') === '1';
  }

  function _autoInit() {
    if (!shouldActivate()) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _boot);
    } else {
      _boot();
    }
  }

  function _boot() {
    // Idempotency guard - if the chrome is already mounted, do nothing.
    if (document.querySelector('.dr-root')) return;

    // Inject CSS link if not already present (when packaged, the deck includes review.css next to review.js)
    if (!document.querySelector('link[data-deck-review]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.dataset.deckReview = '';
      // Resolve relative to this script tag
      const script = document.currentScript || document.querySelector('script[data-review-mode]');
      const src = script && script.getAttribute('src');
      if (src) {
        link.href = src.replace(/review\.js$/, 'review.css');
        document.head.appendChild(link);
      } else {
        console.warn('[deck-review] could not resolve review.css path; widget will render unstyled. Inject the stylesheet manually or fix the script tag src.');
      }
    }

    // Root container
    const root = document.createElement('div');
    root.className = 'dr-root';
    document.body.appendChild(root);

    // Status chip
    const status = document.createElement('div');
    status.className = 'dr-status';
    status.textContent = 'Review Mode · 0 comments';
    root.appendChild(status);

    // Dock
    const dock = document.createElement('div');
    dock.className = 'dr-dock';
    dock.innerHTML = `
      <button class="dr-dock-btn dr-active" data-tool="pick" title="Pick element (hover to highlight, click to anchor a comment)">🎯</button>
      <button class="dr-dock-btn" data-tool="pin" title="Pin tool (drop a pin anywhere, including whitespace)">📍</button>
      <button class="dr-dock-btn" data-tool="highlight" title="Highlight text (select text to anchor a comment)">✎</button>
      <div class="dr-dock-sep"></div>
      <div class="dr-dock-count">0 comments</div>
      <div class="dr-dock-sep"></div>
      <button class="dr-dock-cta" data-action="copy">📋 Copy review</button>
    `;
    root.appendChild(dock);

    // Drawer peek
    const peek = document.createElement('div');
    peek.className = 'dr-drawer-peek';
    peek.textContent = '0 comments ›';
    root.appendChild(peek);

    // Expose state so later tasks can mutate it
    window._deckReviewState = { root, status, dock, peek, comments: [] };

    // Tool switching
    dock.addEventListener('click', (e) => {
      const tBtn = e.target.closest('[data-tool]');
      if (tBtn) { _setTool(tBtn.dataset.tool); return; }
    });
    // Pin-place handler (capture phase so we beat deck event handlers)
    document.addEventListener('click', _onStageClick, true);
    // Picker tool - hover highlight + click to anchor
    document.addEventListener('mousemove', _onPickMove);
    document.addEventListener('click', _onPickClick, true);
    // Highlight-tool selection handler
    document.addEventListener('mouseup', _onTextSelect);
    // Pin click → open popover (capture phase, runs before _onStageClick's slide check)
    document.addEventListener('click', _onPinClick, true);
    // Drawer peek toggle
    peek.addEventListener('click', _openDrawer);

    // Copy review / Submit review action - swap based on environment
    const ctaBtn = dock.querySelector('[data-action="copy"]');
    const ghRepo = detectGitHubRepo(location);
    if (ghRepo) {
      ctaBtn.innerHTML = '📩 Submit review';
      ctaBtn.title = `Opens a GitHub issue on ${ghRepo.user}/${ghRepo.repo} with your review prefilled. Payload also copied to clipboard.`;
      ctaBtn.addEventListener('click', () => _onSubmitToGitHub(ghRepo));
      console.log(`[deck-review] connected mode: ${ghRepo.user}/${ghRepo.repo}`);
    } else {
      ctaBtn.addEventListener('click', _onCopyReview);
    }

    // Escape key - close any open overlay and deactivate any active tool
    document.addEventListener('keydown', _onEscape);
    // Picker is the default tool - more precise than pin, more deliberate than highlight.
    _setTool('pick');

    console.log('[deck-review] UI mounted');
  }

  function _onEscape(e) {
    if (e.key !== 'Escape') return;
    // Run any pending onCancel on an open input so highlights get reverted
    document.querySelectorAll('.dr-input').forEach(n => {
      if (n._drOnCancel) n._drOnCancel();
      n.remove();
    });
    document.querySelectorAll('.dr-popover, .dr-drawer').forEach(n => n.remove());
    _clearPickOverlay();
    // Deactivate any tool so the cursor returns to normal
    if (_activeTool) _setTool(_activeTool); // toggling current tool returns to null
  }

  // ---------- Pin tool ----------

  // Starts null - the initial _setTool('pin') call in _boot activates it correctly.
  let _activeTool = null;
  let _commentCounter = 0;

  function _setTool(name) {
    // If clicking the active tool again, toggle off (no tool active).
    if (name && name === _activeTool) name = null;
    _activeTool = name;
    document.body.classList.toggle('dr-pin-mode', name === 'pin');
    document.body.classList.toggle('dr-pick-mode', name === 'pick');
    // Clear any lingering picker overlay when switching away from picker
    if (name !== 'pick') _clearPickOverlay();
    const state = window._deckReviewState;
    if (!state) return;
    state.dock.querySelectorAll('[data-tool]').forEach(btn => {
      btn.classList.toggle('dr-active', btn.dataset.tool === name);
    });
  }

  function _onStageClick(e) {
    if (_activeTool !== 'pin') return;
    // Ignore clicks on the widget itself
    if (e.target.closest('.dr-root') || e.target.closest('.dr-pin') || e.target.closest('.dr-input')) return;

    const slideEl = e.target.closest('[data-slide-id]');
    if (!slideEl) return; // ignore clicks outside a slide

    e.preventDefault();
    e.stopPropagation();

    // Coords relative to slide
    const rect = slideEl.getBoundingClientRect();
    const xRel = (e.clientX - rect.left) / rect.width;
    const yRel = (e.clientY - rect.top) / rect.height;

    _openCommentInput({
      pageX: e.pageX,
      pageY: e.pageY,
      target: e.target,
      slideEl,
      coords: { x: +xRel.toFixed(4), y: +yRel.toFixed(4) },
    });
  }

  // ---------- Picker tool (inspect-element style) ----------

  let _pickOverlay = null;
  let _pickHoverEl = null;

  function _clearPickOverlay() {
    if (_pickOverlay) {
      _pickOverlay.remove();
      _pickOverlay = null;
    }
    _pickHoverEl = null;
  }

  function _pickShouldIgnore(target) {
    return !!(target.closest && (
      target.closest('.dr-root')
      || target.closest('.dr-pin')
      || target.closest('.dr-input')
      || target.closest('.dr-popover')
      || target.closest('.dr-drawer')
      || target.closest('.dr-pick-overlay')
    ));
  }

  function _onPickMove(e) {
    if (_activeTool !== 'pick') { _clearPickOverlay(); return; }
    if (_pickShouldIgnore(e.target)) { _clearPickOverlay(); return; }
    const slideEl = e.target.closest('[data-slide-id]');
    if (!slideEl) { _clearPickOverlay(); return; }
    if (e.target === _pickHoverEl) return;  // throttle - no change
    _pickHoverEl = e.target;

    const rect = e.target.getBoundingClientRect();
    if (!_pickOverlay) {
      _pickOverlay = document.createElement('div');
      _pickOverlay.className = 'dr-pick-overlay';
      _pickOverlay.innerHTML = '<div class="dr-pick-label"></div>';
      document.body.appendChild(_pickOverlay);
    }
    _pickOverlay.style.left = `${rect.left}px`;
    _pickOverlay.style.top = `${rect.top}px`;
    _pickOverlay.style.width = `${rect.width}px`;
    _pickOverlay.style.height = `${rect.height}px`;

    const tag = e.target.tagName.toLowerCase();
    const id = e.target.getAttribute('data-review-id');
    const cls = (e.target.className || '').toString().split(/\s+/).filter(Boolean).find(c => !c.startsWith('dr-'));
    const label = tag + (id ? `[data-review-id="${id}"]` : (cls ? `.${cls}` : ''));
    _pickOverlay.querySelector('.dr-pick-label').textContent = label;
  }

  function _onPickClick(e) {
    if (_activeTool !== 'pick') return;
    if (_pickShouldIgnore(e.target)) return;
    const slideEl = e.target.closest('[data-slide-id]');
    if (!slideEl) return;

    e.preventDefault();
    e.stopPropagation();
    _clearPickOverlay();

    _openCommentInput({
      pageX: e.pageX,
      pageY: e.pageY,
      target: e.target,
      slideEl,
      coords: null, // picker anchors by element, not coords
    });
  }

  function _onTextSelect() {
    if (_activeTool !== 'highlight') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    // startContainer may be a Text node (typical click-drag) or an Element (e.g., triple-click).
    // For Text nodes use the parent Element as the target; for Elements use the container itself.
    const sc = range.startContainer;
    const sourceParent = sc.nodeType === 3 ? sc.parentElement : sc;
    const slideEl = sourceParent && sourceParent.closest && sourceParent.closest('[data-slide-id]');
    if (!slideEl) return;

    // Capture the highlighted text BEFORE wrapping, so the snippet reflects the actual selection
    // (not the entire parent element's text content).
    const highlightedText = range.toString().trim();

    // Wrap selection in a <span class="dr-highlight">
    const span = document.createElement('span');
    span.className = 'dr-highlight';
    let crossesBoundary = false;
    try {
      range.surroundContents(span);
    } catch {
      // surroundContents fails on partial selections crossing elements; fall back: insert mark manually
      crossesBoundary = true;
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    sel.removeAllRanges();

    // Anchor target = the source-DOM parent element (so the selector resolves in the saved HTML),
    // EXCEPT when the selection crossed element boundaries — then the span sits as a sibling of
    // text fragments and the source-parent is no longer the right anchor.
    const anchorTarget = crossesBoundary ? span : sourceParent;

    const rect = span.getBoundingClientRect();
    _openCommentInput({
      pageX: rect.right + window.scrollX,
      pageY: rect.top + window.scrollY,
      target: anchorTarget,
      slideEl,
      coords: null, // highlights anchor by selector + text, not coords
      // Use the highlighted text itself as the snippet, not the parent element's full textContent.
      textSnippet: highlightedText.slice(0, 60),
      // If the user cancels/Escs/abandons this comment, unwrap the highlight
      // so the deck DOM returns to its original state.
      onCancel: () => _unwrapHighlight(span),
    });
  }

  function _unwrapHighlight(span) {
    if (!span || !span.parentNode) return;
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }

  function _openCommentInput({ pageX, pageY, target, slideEl, coords, textSnippet, onCancel }) {
    // If there's already an open input with unsaved text, ignore this attempt
    // (avoids losing the reviewer's in-progress comment on a stray click).
    const existing = document.querySelector('.dr-input');
    if (existing) {
      const existingTa = existing.querySelector('textarea');
      if (existingTa && existingTa.value.trim()) {
        existingTa.focus();
        // The new attempt is abandoned - run its onCancel so highlight DOM gets reverted.
        if (onCancel) onCancel();
        return;
      }
      // Replace the existing empty input - run its stored onCancel first so its highlight gets unwrapped.
      if (existing._drOnCancel) existing._drOnCancel();
      existing.remove();
    }

    const input = document.createElement('div');
    input.className = 'dr-input';
    input.style.left = `${pageX + 12}px`;
    input.style.top = `${pageY + 12}px`;
    input.innerHTML = `
      <textarea placeholder="Leave a comment..."></textarea>
      <div class="dr-input-row">
        <button class="dr-cancel" type="button">Cancel</button>
        <button class="dr-save" type="button">Save</button>
      </div>
    `;
    document.body.appendChild(input);
    // Stash the cancel callback on the element so Esc/replace flows can call it.
    input._drOnCancel = onCancel;
    const ta = input.querySelector('textarea');
    ta.focus();

    const saveBtn = input.querySelector('.dr-save');
    let saving = false;

    const cleanupCancelled = () => {
      if (onCancel) onCancel();
      input.remove();
    };

    input.querySelector('.dr-cancel').addEventListener('click', cleanupCancelled);
    saveBtn.addEventListener('click', () => {
      if (saving) return;  // guard against double-click
      const body = ta.value.trim();
      if (!body) { cleanupCancelled(); return; }
      saving = true;
      saveBtn.disabled = true;
      _commentCounter += 1;
      const comment = {
        id: `c${_commentCounter}`,
        slide: slideEl.dataset.slideId,
        anchor: _buildAnchor(target, slideEl, coords, textSnippet),
        body,
        created_at: new Date().toISOString(),
        _pageX: pageX,
        _pageY: pageY,
      };
      window._deckReviewState.comments.push(comment);
      _renderPin(comment);
      _updateCounts();
      input.remove();
    });
  }

  function _buildAnchor(target, slideEl, coords, snippetOverride) {
    return {
      review_id: target.getAttribute('data-review-id') || null,
      selector: _cssSelector(target, slideEl),
      // For highlights, caller passes the highlighted text explicitly. For pins, we derive
      // the snippet from the clicked element's text content.
      text_snippet: typeof snippetOverride === 'string'
        ? snippetOverride
        : (target.textContent || '').trim().slice(0, 60),
      coords: coords || null,
    };
  }

  function _cssSelector(el, root) {
    const path = [];
    let cur = el;
    while (cur && cur !== root && cur.nodeType === 1) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { part += `#${cur.id}`; path.unshift(part); break; }
      const sibs = cur.parentNode ? Array.from(cur.parentNode.children).filter(c => c.tagName === cur.tagName) : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      path.unshift(part);
      cur = cur.parentNode;
    }
    const slideId = root.getAttribute('data-slide-id');
    const base = `section[data-slide-id='${slideId}']`;
    // If the click landed on the slide root itself, return just the slide selector.
    return path.length === 0 ? base : `${base} > ${path.join(' > ')}`;
  }

  function _renderPin(comment) {
    // Pins live inside the body absolutely positioned, anchored to page coords for v1
    const pin = document.createElement('div');
    pin.className = 'dr-pin';
    pin.style.left = `${comment._pageX - 13}px`;
    pin.style.top = `${comment._pageY - 13}px`;
    pin.dataset.commentId = comment.id;
    pin.innerHTML = `<span>${comment.id.replace('c', '')}</span>`;
    document.body.appendChild(pin);
  }

  function _updateCounts() {
    const state = window._deckReviewState;
    if (!state) return;
    const n = state.comments.length;
    state.status.textContent = `Review Mode · ${n} comment${n === 1 ? '' : 's'}`;
    state.dock.querySelector('.dr-dock-count').textContent = `${n} comment${n === 1 ? '' : 's'}`;
    state.peek.textContent = `${n} comment${n === 1 ? '' : 's'} ›`;
  }

  function _deleteComment(id) {
    const state = window._deckReviewState;
    if (!state) return;
    const idx = state.comments.findIndex(c => c.id === id);
    if (idx === -1) return;
    const comment = state.comments[idx];
    // Remove pin from DOM
    const pin = document.querySelector(`.dr-pin[data-comment-id="${id}"]`);
    if (pin) pin.remove();
    // If this was a highlight comment, unwrap the orange span back to plain text
    if (comment.anchor && comment.anchor.coords === null) {
      const slideEl = document.querySelector(`section[data-slide-id="${comment.slide}"]`);
      if (slideEl) {
        // Find the most-likely highlight span by text match within the slide
        const spans = slideEl.querySelectorAll('span.dr-highlight');
        for (const span of spans) {
          if ((span.textContent || '').includes(comment.anchor.text_snippet)) {
            _unwrapHighlight(span);
            break;
          }
        }
      }
    }
    // Remove from state, close any open popover, refresh counts
    state.comments.splice(idx, 1);
    document.querySelectorAll('.dr-popover, .dr-drawer').forEach(n => n.remove());
    _updateCounts();
  }

  // ---------- Popover + Drawer ----------

  function _openPopover(comment) {
    document.querySelectorAll('.dr-popover, .dr-input').forEach(n => n.remove());
    // Close the drawer if open - otherwise the popover can be hidden behind it.
    const drawer = document.querySelector('.dr-drawer');
    if (drawer) drawer.remove();
    const reviewer = _getReviewer();
    const ago = _relativeTime(new Date(comment.created_at));

    const pop = document.createElement('div');
    pop.className = 'dr-popover';
    pop.style.left = `${comment._pageX + 18}px`;
    pop.style.top = `${comment._pageY + 18}px`;
    pop.innerHTML = `
      <div class="dr-pop-head">
        <div class="dr-avatar">${_escapeHtml(reviewer.initials || '?')}</div>
        <div class="dr-pop-name">${_escapeHtml(reviewer.name || 'Anonymous')}</div>
        <div class="dr-pop-time">${_escapeHtml(ago)}</div>
      </div>
      <div class="dr-pop-body">${_escapeHtml(comment.body)}</div>
      <div class="dr-pop-anchor">anchor · ${_escapeHtml(comment.slide)} · ${_escapeHtml(comment.anchor.selector)}</div>
      <div class="dr-pop-actions">
        <button class="dr-pop-delete" type="button" title="Delete this comment">Delete</button>
      </div>
    `;
    document.body.appendChild(pop);

    pop.querySelector('.dr-pop-delete').addEventListener('click', (ev) => {
      ev.stopPropagation();
      _deleteComment(comment.id);
    });

    // Click outside to close
    setTimeout(() => {
      const close = (ev) => { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', close, true); } };
      document.addEventListener('click', close, true);
    }, 0);
  }

  function _onPinClick(e) {
    const pin = e.target.closest('.dr-pin');
    if (!pin) return;
    e.preventDefault(); e.stopPropagation();
    const id = pin.dataset.commentId;
    const comment = window._deckReviewState.comments.find(c => c.id === id);
    if (comment) _openPopover(comment);
  }

  function _openDrawer() {
    const existing = document.querySelector('.dr-drawer');
    if (existing) { existing.remove(); return; }
    const state = window._deckReviewState;
    const drawer = document.createElement('div');
    drawer.className = 'dr-drawer';
    drawer.innerHTML = `
      <button class="dr-drawer-close" type="button">×</button>
      <h3>${state.comments.length} comment${state.comments.length === 1 ? '' : 's'}</h3>
      ${state.comments.map(c => `
        <div class="dr-drawer-item" data-comment-id="${c.id}">
          <div class="meta">${c.slide} · ${c.id}</div>
          <div class="body">${_escapeHtml(c.body)}</div>
        </div>
      `).join('')}
    `;
    document.body.appendChild(drawer);
    drawer.querySelector('.dr-drawer-close').addEventListener('click', () => drawer.remove());
    drawer.querySelectorAll('[data-comment-id]').forEach(item => {
      item.addEventListener('click', () => {
        const c = state.comments.find(x => x.id === item.dataset.commentId);
        if (c) _openPopover(c);
      });
    });
  }

  function _getReviewer() {
    let name = '';
    try { name = localStorage.getItem('dr_reviewer_name') || ''; } catch {}
    if (!name) {
      name = prompt('Your name (for review attribution)') || '';
      if (name) { try { localStorage.setItem('dr_reviewer_name', name); } catch {} }
    }
    return { name, initials: deriveInitials(name) };
  }

  function _relativeTime(date) {
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return date.toLocaleDateString();
  }

  function _escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // ---------- Copy review ----------

  async function _onCopyReview() {
    const state = window._deckReviewState;
    if (!state || state.comments.length === 0) {
      alert('No comments to copy yet.');
      return;
    }
    const reviewer = _getReviewer();
    const payload = buildPayload({
      deck: location.pathname.split('/').pop() || 'deck.html',
      reviewer,
      comments: state.comments.map(c => ({
        id: c.id, slide: c.slide, anchor: c.anchor, body: c.body, created_at: c.created_at,
      })),
      exported_at: new Date().toISOString(),
    });
    try {
      await navigator.clipboard.writeText(payload);
      const btn = state.dock.querySelector('[data-action="copy"]');
      const original = btn.innerHTML;
      btn.innerHTML = '✓ Copied';
      setTimeout(() => { btn.innerHTML = original; }, 1500);
    } catch (err) {
      // Fallback: show in a textarea so the user can select-all + copy manually
      const fallback = document.createElement('textarea');
      fallback.value = payload;
      fallback.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:600px;height:400px;z-index:2147483647;padding:10px;';
      document.body.appendChild(fallback);
      fallback.select();
      alert('Clipboard blocked. Copy the text below manually, then click OK to dismiss.');
      fallback.remove();
    }
  }

  // ---------- Submit to GitHub (connected mode) ----------

  async function _onSubmitToGitHub(ghRepo) {
    const state = window._deckReviewState;
    if (!state || state.comments.length === 0) {
      alert('No comments to submit yet.');
      return;
    }
    const reviewer = _getReviewer();
    const deck = location.pathname.split('/').pop() || 'deck.html';
    const payload = buildPayload({
      deck,
      reviewer,
      comments: state.comments.map(c => ({
        id: c.id, slide: c.slide, anchor: c.anchor, body: c.body, created_at: c.created_at,
      })),
      exported_at: new Date().toISOString(),
    });

    // Belt-and-suspenders: copy to clipboard too, so reviewer can paste manually if needed.
    try { await navigator.clipboard.writeText(payload); } catch {}

    const { url, prefilled } = buildIssueUrl({
      user: ghRepo.user, repo: ghRepo.repo,
      deck, reviewerName: reviewer.name,
      commentCount: state.comments.length, payload,
    });

    if (!prefilled) {
      // Payload too long to prefill - tell the reviewer to paste manually.
      alert('Review payload is too large to prefill into the GitHub URL. The full payload was copied to your clipboard - paste it into the new issue body that opens.');
    }

    window.open(url, '_blank', 'noopener');

    const btn = state.dock.querySelector('[data-action="copy"]');
    const original = btn.innerHTML;
    btn.innerHTML = '✓ Opening issue';
    setTimeout(() => { btn.innerHTML = original; }, 1800);
  }

  return {
    deriveInitials,
    buildPayload,
    parsePayload,
    detectGitHubRepo,
    buildIssueUrl,
    _autoInit,
    _boot,
  };
});
