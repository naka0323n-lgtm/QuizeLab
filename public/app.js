const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const letters = ["ア", "イ", "ウ", "エ", "オ", "カ"];
let questions = [],
  history = [],
  nodes = [],
  tags = [];
let activeId = null,
  view = "library",
  search = "",
  tagFilter = "",
  statusFilter = "learning";
let selected = new Set(),
  exam = null,
  result = null,
  timer,
  submitting = false;
let studyLimit = 10,
  shuffle = true;
const collapsed = new Set();
async function api(path, method = "GET", data) {
  const response = await fetch("/api/" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error);
  return value;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 3500);
}
async function load() {
  [questions, history, nodes, tags] = await Promise.all([
    api("questions"),
    api("attempts"),
    api("collections"),
    api("tags"),
  ]);
  if (activeId && !nodes.some((n) => n.id === activeId)) activeId = null;
  selected = new Set(
    [...selected].filter((id) => questions.some((q) => q.id === id)),
  );
}
const activeNode = () => nodes.find((n) => n.id === activeId);
function pathFor(node) {
  const names = [];
  while (node) {
    names.unshift(node.name);
    node = nodes.find((n) => n.id === node.parent_id);
  }
  return names.join(" / ");
}
function childrenOf(id) {
  return nodes.filter((n) => n.parent_id === id);
}
function descendantIds(id) {
  return [id, ...childrenOf(id).flatMap((n) => descendantIds(n.id))];
}
function scopeQuestions() {
  return activeId
    ? questions.filter((q) => descendantIds(activeId).includes(q.deck_id))
    : questions;
}
function resetFilters() {
  search = "";
  tagFilter = "";
  statusFilter = "learning";
  selected.clear();
}
function selectNode(id) {
  activeId = id;
  view = "library";
  resetFilters();
  render();
}
function tree(parent = null, depth = 0) {
  return childrenOf(parent)
    .map(
      (n) =>
        `<div class="tree-node depth-${Math.min(depth, 8)}"><div class="tree-row ${activeId === n.id ? "active" : ""}">${n.kind === "category" ? `<button class="tree-toggle" data-collapse="${n.id}" aria-label="${esc(n.name)}を展開・折りたたみ" aria-expanded="${!collapsed.has(n.id)}">${collapsed.has(n.id) ? "▸" : "▾"}</button>` : '<span class="tree-book">▤</span>'}<button class="tree-name" data-node="${n.id}" title="${esc(pathFor(n))}">${esc(n.name)}</button><span class="tree-count" title="学習中 / 全問題">${n.total - n.mastered}<small> / ${n.total}</small></span><button class="tree-menu" data-manage="${n.id}" aria-label="${esc(n.name)}の設定">⋯</button></div>${n.kind === "category" && !collapsed.has(n.id) ? `<div class="tree-children">${tree(n.id, depth + 1)}${!childrenOf(n.id).length ? '<p class="tree-empty">まだ問題集がありません</p>' : ""}</div>` : ""}</div>`,
    )
    .join("");
}
function shell(content) {
  $("#app").innerHTML =
    `<header class="app-header"><button class="brand" id="brand"><span class="brand-icon">Q</span><span>QuizeLab<small>自分だけの問題集</small></span></button><nav><button data-view="library" class="${view === "library" ? "active" : ""}">▤ 問題集</button><button data-view="history" class="${view === "history" ? "active" : ""}">◷ 学習履歴</button></nav><span class="local-badge">● ローカル保存</span></header><div class="workspace"><main>${content}</main><aside class="collection-sidebar"><div class="rail-heading"><div><span class="eyebrow">MY COLLECTIONS</span><h2>問題集</h2></div><button class="icon-button" id="new-deck-rail" aria-label="問題集を作成">＋</button></div><button class="all-collections ${activeId === null ? "active" : ""}" id="all-collections">▦ すべての問題集 <span>${nodes.filter((n) => n.kind === "deck").length}</span></button><div class="collection-tree">${tree() || '<p class="rail-empty">カテゴリと問題集を作成して<br>学習を始めましょう。</p>'}</div><div class="rail-actions"><button class="secondary import-button" id="import-deck">↓ 問題集を読み込む</button><input type="file" id="shared-file" accept=".quizelab,.json" hidden><button class="secondary" id="new-category">＋ カテゴリを作成</button><button class="secondary" id="new-deck">＋ 問題集を作成</button></div><div class="rail-note"><span class="dot"></span>データはこのパソコンに保存<p>数字は「学習中 / 全問題」です。<br>習得済みの問題も削除せず保管します。</p></div></aside></div>`;
  $("#brand").onclick = () => selectNode(null);
  $("#all-collections").onclick = () => selectNode(null);
  document.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        view = b.dataset.view;
        render();
      }),
  );
  document
    .querySelectorAll("[data-node]")
    .forEach((b) => (b.onclick = () => selectNode(+b.dataset.node)));
  document
    .querySelectorAll("[data-manage]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          collectionEditor(nodes.find((n) => n.id === +b.dataset.manage))),
    );
  document.querySelectorAll("[data-collapse]").forEach(
    (b) =>
      (b.onclick = () => {
        const id = +b.dataset.collapse;
        collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
        render();
      }),
  );
  $("#import-deck").onclick = () => $("#shared-file").click();
  $("#shared-file").onchange = (event) => {
    const file = event.target.files[0];
    if (file) importSharedFile(file);
    event.target.value = "";
  };
  $("#new-category").onclick = () => collectionEditor(null, "category");
  $("#new-deck").onclick = $("#new-deck-rail").onclick = () =>
    collectionEditor(null, "deck");
}
function statsHTML(items) {
  const answered = items.filter((q) => q.answer_count > 0).length,
    mastered = items.filter((q) => q.mastered).length;
  const attempts = items.reduce((n, q) => n + q.answer_count, 0),
    correct = items.reduce((n, q) => n + q.correct_count, 0);
  return `<div class="stats"><div><span>登録問題</span><strong>${items.length}<small>問</small></strong><p>学習中 ${items.length - mastered} 問</p></div><div><span>回答率</span><strong>${items.length ? Math.round((answered / items.length) * 100) : 0}<small>%</small></strong><p>${answered} / ${items.length} 問に回答済み</p></div><div><span>正答率</span><strong>${attempts ? Math.round((correct / attempts) * 100) : "—"}<small>%</small></strong><p>${attempts} 回の解答中 ${correct} 回正解</p></div><div><span>習得率</span><strong>${items.length ? Math.round((mastered / items.length) * 100) : 0}<small>%</small></strong><p>${mastered} / ${items.length} 問を習得</p></div></div>`;
}
function render() {
  if (exam) return renderExam();
  if (result) return renderResult();
  if (view === "history") return renderHistory();
  if (activeNode()?.kind === "deck") return renderDeck();
  renderOverview();
}
function renderOverview() {
  const node = activeNode(),
    ids = node ? descendantIds(node.id) : nodes.map((n) => n.id);
  const decks = nodes.filter((n) => n.kind === "deck" && ids.includes(n.id));
  shell(
    `<section class="page"><div class="eyebrow">YOUR LEARNING WORKSPACE</div><div class="page-heading"><div><div class="breadcrumb">${node ? esc(pathFor(node)) : "ワークスペース"}</div><h1>${node ? esc(node.name) : "自分だけの問題集"}</h1><p>問題集をつくって、繰り返し学ぶ。5回の正解を、確かな自信に。</p></div><button class="primary" id="create-deck">＋ 問題集を作成</button></div>${statsHTML(scopeQuestions())}<div class="section-heading"><h2>${node ? "このカテゴリの問題集" : "問題集一覧"}</h2><span>${decks.length} 冊</span></div><div class="deck-grid">${decks.map((d) => `<button class="deck-card" data-open="${d.id}"><div class="deck-card-top"><span class="deck-symbol">▤</span><span class="tag">${d.total - d.mastered} 問 学習中</span></div><p class="deck-path">${d.parent_id ? esc(pathFor(nodes.find((n) => n.id === d.parent_id))) : "未分類"}</p><h2>${esc(d.name)}</h2><p>${d.total} 問 · ${d.mastery_mode === "streak" ? "連続" : "累計"} ${d.mastery_target} 回正解で習得</p><div class="deck-progress-label"><span>習得済み ${d.mastered} / ${d.total}</span><b>${d.total ? Math.round((d.mastered / d.total) * 100) : 0}%</b></div><progress max="${d.total || 1}" value="${d.mastered}"></progress><div class="deck-card-bottom"><span>正答率 ${d.accuracy === null ? "—" : d.accuracy + "%"}</span><span>問題集を開く →</span></div></button>`).join("") || `<div class="empty"><div class="empty-icon">▤</div><h2>まずは、問題集をつくりましょう</h2><p>例：カテゴリ「基本情報技術者」の下に<br>「テクノロジ」「マネジメント」の問題集を作れます。</p><button class="secondary" id="empty-deck">＋ 最初の問題集を作成</button></div>`}</div><footer>QuizeLab <span>学習データは、このパソコンの中に。</span></footer></section>`,
  );
  $("#create-deck").onclick = () => collectionEditor(null, "deck");
  if ($("#empty-deck"))
    $("#empty-deck").onclick = () => collectionEditor(null, "deck");
  document
    .querySelectorAll("[data-open]")
    .forEach((b) => (b.onclick = () => selectNode(+b.dataset.open)));
}
function filteredQuestions() {
  return scopeQuestions().filter(
    (q) =>
      (statusFilter === "all" ||
        (statusFilter === "mastered" ? q.mastered : !q.mastered)) &&
      (!tagFilter || q.tags.includes(tagFilter)) &&
      (q.title + " " + q.tags.join(" "))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
}
function renderDeck() {
  const deck = activeNode(),
    items = scopeQuestions(),
    filtered = filteredQuestions();
  selected = new Set(
    [...selected].filter((id) => filtered.some((q) => q.id === id)),
  );
  const eligible = selected.size
    ? filtered.filter((q) => selected.has(q.id))
    : filtered.filter((q) => statusFilter === "mastered" || !q.mastered);
  const mastered = items.filter((q) => q.mastered).length;
  shell(
    `<section class="page"><div class="eyebrow">QUESTION COLLECTION</div><div class="page-heading"><div><div class="breadcrumb">${esc(pathFor(deck))}</div><h1>${esc(deck.name)}</h1><p>${deck.mastery_mode === "streak" ? "連続" : "累計"} ${deck.mastery_target} 回正解で習得。習得した問題は、通常の出題から外れます。</p></div><div class="heading-actions"><button class="secondary" id="share-deck">↗ 共有</button><button class="secondary" id="deck-settings">問題集の設定</button><button class="primary" id="create">＋ 問題を追加</button></div></div>${statsHTML(items)}<section class="study-banner"><div><span class="eyebrow">PRACTICE SESSION</span><h2>${selected.size ? selected.size + " 問を選択中" : statusFilter === "mastered" ? "習得済みの問題を復習" : "今日も、ひとつずつ習得する。"}</h2><p>${eligible.length} 問が出題対象${statusFilter === "all" && !selected.size ? "（習得済みを除外）" : ""} · 問題を選ばずに、そのまま始められます。</p></div><div class="study-controls"><label>出題数<select id="question-limit">${[
      [10, "10 問まで"],
      [20, "20 問まで"],
      [50, "50 問まで"],
      [500, "すべて（最大500問）"],
    ]
      .map(
        ([v, label]) =>
          `<option value="${v}" ${studyLimit === v ? "selected" : ""}>${label}</option>`,
      )
      .join(
        "",
      )}</select></label><label class="shuffle"><input type="checkbox" id="shuffle" ${shuffle ? "checked" : ""}>シャッフル</label><button class="primary" id="start" ${!eligible.length ? "disabled" : ""}>${statusFilter === "mastered" ? "復習" : "学習"}を開始 →</button></div></section><section class="question-panel"><div class="panel-toolbar"><div class="status-tabs" role="group" aria-label="習得状況で絞り込み">${[
      ["learning", "学習中", items.length - mastered],
      ["mastered", "習得済み", mastered],
      ["all", "すべて", items.length],
    ]
      .map(
        ([value, label, count]) =>
          `<button data-status="${value}" class="${statusFilter === value ? "active" : ""}" aria-pressed="${statusFilter === value}">${label}<span>${count}</span></button>`,
      )
      .join(
        "",
      )}</div><div class="filters"><label class="search"><span>⌕</span><input id="search" aria-label="問題を検索" placeholder="問題文・タグで検索" value="${esc(search)}"></label><select id="tag-filter" aria-label="タグで絞り込み"><option value="">すべてのタグ</option>${[...new Set(items.flatMap((q) => q.tags))].map((t) => `<option value="${esc(t)}" ${tagFilter === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div></div><div class="list-heading"><label><input type="checkbox" id="all" ${filtered.length && filtered.every((q) => selected.has(q.id)) ? "checked" : ""}>表示中の問題をすべて選択</label><span>${filtered.length} 件</span></div><div class="question-list">${filtered.map((q) => `<article class="question-row ${selected.has(q.id) ? "selected" : ""}"><input type="checkbox" data-select="${q.id}" aria-label="${esc(q.title)}を選択" ${selected.has(q.id) ? "checked" : ""}><div class="question-content"><div class="question-tags">${q.mastered ? '<span class="mastered-tag">✓ 習得済み</span>' : ""}${q.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div><h3>${esc(q.title)}</h3><div class="question-meta"><span>${q.options.length} 択 · 回答 ${q.answer_count} 回 · 正解 ${q.correct_count} 回${q.mastery_mode === "streak" ? " · 連続 " + q.streak + " 回正解" : ""}</span><span class="mastery-indicator" aria-label="習得まで ${Math.min(q.progress_count, q.mastery_target)} / ${q.mastery_target} 回正解">${Array.from({ length: q.mastery_target }, (_, i) => `<i class="${i < q.progress_count ? "filled" : ""}"></i>`).join("")}<b>${q.progress_count} / ${q.mastery_target}</b></span></div></div><button class="edit" data-edit="${q.id}">編集 ↗</button></article>`).join("") || `<div class="empty"><div class="empty-icon">${items.length && !filtered.length && statusFilter === "learning" && !search && !tagFilter ? "✓" : "▤"}</div><h2>${!items.length ? "この問題集に問題を追加しましょう" : statusFilter === "learning" && mastered === items.length && !search && !tagFilter ? "すべての問題を習得しました！" : "該当する問題がありません"}</h2><p>${!items.length ? "問題文・選択肢・正解を登録すると、学習を始められます。" : statusFilter === "learning" && mastered === items.length ? "「習得済み」からいつでも確認・復習できます。" : "絞り込み条件を変更してみてください。"}</p>${!items.length ? '<button class="secondary" id="first">＋ 最初の問題を追加</button>' : ""}</div>`}</div></section><footer>回答率：1回以上回答した問題の割合 <span>正答率：全解答に対する正解の割合</span></footer></section>`,
  );
  $("#create").onclick = () => editor();
  if ($("#first")) $("#first").onclick = () => editor();
  $("#share-deck").onclick = () => shareDeck(deck);
  $("#deck-settings").onclick = () => collectionEditor(deck);
  $("#search").oninput = (e) => {
    const position = e.target.selectionStart;
    search = e.target.value;
    selected.clear();
    renderDeck();
    $("#search").focus();
    $("#search").setSelectionRange(position, position);
  };
  $("#tag-filter").onchange = (e) => {
    tagFilter = e.target.value;
    selected.clear();
    renderDeck();
  };
  document.querySelectorAll("[data-status]").forEach(
    (b) =>
      (b.onclick = () => {
        statusFilter = b.dataset.status;
        selected.clear();
        renderDeck();
      }),
  );
  $("#all").onchange = (e) => {
    filtered.forEach((q) =>
      e.target.checked ? selected.add(q.id) : selected.delete(q.id),
    );
    renderDeck();
  };
  document.querySelectorAll("[data-select]").forEach(
    (b) =>
      (b.onchange = () => {
        b.checked
          ? selected.add(+b.dataset.select)
          : selected.delete(+b.dataset.select);
        renderDeck();
      }),
  );
  document
    .querySelectorAll("[data-edit]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          editor(questions.find((q) => q.id === +b.dataset.edit))),
    );
  $("#question-limit").onchange = (e) => {
    studyLimit = +e.target.value;
  };
  $("#shuffle").onchange = (e) => {
    shuffle = e.target.checked;
  };
  $("#start").onclick = () => {
    let items = [...eligible];
    if ($("#shuffle").checked)
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    startExam(items.slice(0, +$("#question-limit").value));
  };
}
function modal(contents) {
  const dialog = document.createElement("dialog");
  dialog.className = "editor";
  dialog.innerHTML = contents;
  document.body.append(dialog);
  dialog.showModal();
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.querySelectorAll("[data-close]").forEach((b) => (b.onclick = close));
  dialog.oncancel = (e) => {
    e.preventDefault();
    close();
  };
  return { dialog, close };
}
function shareDeck(deck) {
  const items = questions.filter((q) => q.deck_id === deck.id);
  const { dialog } = modal(
    `<div class="modal-heading"><div><span class="eyebrow">SHARE A QUESTION COLLECTION</span><h2>問題集を共有</h2></div><button type="button" class="icon-button" data-close aria-label="閉じる">×</button></div><div class="share-deck-title">▤ ${esc(deck.name)}<span>${items.length} 問・${new Set(items.map((q) => q.image_id).filter(Boolean)).size} 枚の画像</span></div><ol class="share-steps"><li><b>共有用ファイルを保存</b><p>問題文・選択肢・正解・解説・タグ・画像を1つにまとめます。習得済みも含めた全問題が対象です。</p></li><li><b>ファイルを相手に渡す</b><p>LINE・メール・USBなど、普段の方法で送れます。アップロードや送信はこのアプリでは行いません。</p></li><li><b>相手が「問題集を読み込む」</b><p>相手にも QuizeLab 1.3.0 以降が必要です。ファイルを選ぶと、学習を最初から始められます。</p></li></ol><div class="share-note">あなたの学習履歴・正解回数は含めません。<br>正解と解説も含む、編集できる問題集のコピーです。</div><p id="share-error" role="alert"></p><div class="modal-footer"><span>1ファイル 50MB・2000問まで</span><button type="button" class="primary" id="save-share">↓ 共有用ファイルを保存</button></div>`,
  );
  $("#save-share").onclick = async () => {
    const button = $("#save-share");
    button.disabled = true;
    button.textContent = "ファイルを作成中…";
    try {
      const response = await fetch(`/api/collections/${deck.id}/export`);
      if (!response.ok) throw Error((await response.json()).error);
      const blob = await response.blob(),
        url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        deck.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80) +
        ".quizelab";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast("保存できたら、.quizelab ファイルを相手に渡してください");
    } catch (error) {
      if (dialog.isConnected) $("#share-error").textContent = error.message;
    } finally {
      if (dialog.isConnected) {
        button.disabled = false;
        button.textContent = "↓ 共有用ファイルを保存";
      }
    }
  };
}
async function importSharedFile(file) {
  if (exam || result)
    return toast("テストを終了し、問題集の画面に戻ってから読み込んでください");
  if (document.querySelector("dialog"))
    return toast("編集中の画面を閉じてから読み込んでください");
  if (!file.size || file.size > 50 * 1024 * 1024)
    return toast("共有ファイルは50MB以下のものを選んでください");
  try {
    let packet;
    try {
      packet = JSON.parse(await file.text());
    } catch {
      throw Error(
        "共有ファイルを読み取れません。相手に .quizelab ファイルを確認してください",
      );
    }
    const parent =
      activeNode()?.kind === "category"
        ? activeId
        : (activeNode()?.parent_id ?? null);
    const preview = await api("share/preview", "POST", {
      package: packet,
      parent_id: parent,
    });
    const { dialog, close } = modal(
      `<form id="import-form"><div class="modal-heading"><div><span class="eyebrow">IMPORT A QUESTION COLLECTION</span><h2>問題集を読み込む</h2></div><button type="button" class="icon-button" data-close aria-label="閉じる">×</button></div><div class="share-summary"><strong>${preview.question_count}<small>問</small></strong><span>画像 ${preview.image_count} 枚 · タグ ${preview.tag_count} 個</span></div><label class="field">問題集の名前<input name="name" required maxlength="100" value="${esc(preview.name)}"></label><label class="field">保存先カテゴリ<select name="parent"><option value="">なし（いちばん上）</option>${nodes
        .filter((n) => n.kind === "category")
        .map(
          (n) =>
            `<option value="${n.id}" ${n.id === parent ? "selected" : ""}>${esc(pathFor(n))}</option>`,
        )
        .join(
          "",
        )}</select></label><div class="share-preview"><b>含まれる問題</b>${preview.titles.map((t) => `<p>${esc(t)}</p>`).join("") || "<p>まだ問題のない問題集です。</p>"}${preview.question_count > 3 ? "<small>ほか " + (preview.question_count - 3) + " 問</small>" : ""}</div><div class="share-note">新しい問題集として追加します。既存の問題集や履歴は上書きしません。同名の場合は末尾に番号を付けます。<br>学習回数は0から開始し、${preview.mastery_mode === "streak" ? "連続" : "累計"}${preview.mastery_target}回正解で習得します。</div><p id="import-error" role="alert"></p><div class="modal-footer"><span></span><div><button type="button" class="secondary" data-close>キャンセル</button><button type="submit" class="primary">問題集を追加する</button></div></div></form>`,
    );
    $("#import-form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target,
        button = form.querySelector("[type=submit]");
      button.disabled = true;
      button.textContent = "読み込み中…";
      try {
        const saved = await api("share/import", "POST", {
          package: packet,
          name: form.elements.name.value,
          parent_id: form.elements.parent.value
            ? +form.elements.parent.value
            : null,
        });
        close();
        activeId = saved.id;
        view = "library";
        resetFilters();
        try {
          await load();
          render();
          toast(saved.name + " を追加しました");
        } catch {
          toast("問題集は追加済みです。画面を開き直してください");
        }
      } catch (error) {
        if (dialog.isConnected) {
          $("#import-error").textContent = error.message;
          button.disabled = false;
          button.textContent = "問題集を追加する";
        }
      }
    };
  } catch (error) {
    toast(error.message);
  }
}
document.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  if (event.dataTransfer.files.length !== 1)
    return toast("共有ファイルを1つずつ読み込んでください");
  importSharedFile(event.dataTransfer.files[0]);
});
function collectionEditor(node, kind = "deck") {
  kind = node?.kind || kind;
  const label = kind === "deck" ? "問題集" : "カテゴリ";
  const parent = node
    ? node.parent_id
    : activeNode()?.kind === "category"
      ? activeId
      : (activeNode()?.parent_id ?? null);
  const excluded = node ? descendantIds(node.id) : [];
  const { dialog, close } = modal(
    `<form id="collection-form"><div class="modal-heading"><div><span class="eyebrow">${kind === "deck" ? "QUESTION COLLECTION" : "CATEGORY"}</span><h2>${label}を${node ? "編集" : "作成"}</h2></div><button class="icon-button" type="button" data-close aria-label="閉じる">×</button></div><label class="field">${label}の名前<input name="name" required maxlength="100" placeholder="${kind === "deck" ? "例：テクノロジ" : "例：基本情報技術者"}" value="${esc(node?.name || "")}"></label><label class="field">上位カテゴリ<select name="parent"><option value="">なし（いちばん上）</option>${nodes
      .filter((n) => n.kind === "category" && !excluded.includes(n.id))
      .map(
        (n) =>
          `<option value="${n.id}" ${parent === n.id ? "selected" : ""}>${esc(pathFor(n))}</option>`,
      )
      .join(
        "",
      )}</select></label>${kind === "deck" ? `<div class="settings-box"><h3>習得のルール</h3><div class="settings-grid"><label class="field">正解回数<input name="target" type="number" min="1" max="20" required value="${node?.mastery_target || 5}"></label><label class="field">カウント方法<select name="mode"><option value="total" ${node?.mastery_mode !== "streak" ? "selected" : ""}>累計の正解回数</option><option value="streak" ${node?.mastery_mode === "streak" ? "selected" : ""}>連続の正解回数</option></select></label></div><p>目標に達した問題を「習得済み」に移し、通常の出題から外します。問題は削除されず、いつでも復習できます。ルール変更は既存の記録にも適用されます。</p></div>` : "<p>カテゴリの中に、さらにカテゴリや問題集を作れます。</p>"}<p id="form-error" role="alert"></p><div class="modal-footer">${node ? '<button type="button" class="danger" id="delete-collection">削除</button>' : "<span></span>"}<div><button type="button" class="secondary" data-close>キャンセル</button><button class="primary" type="submit">${node ? "変更を保存" : "作成する"}</button></div></div></form>`,
  );
  $("#collection-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const saved = await api(
        "collections" + (node ? "/" + node.id : ""),
        node ? "PUT" : "POST",
        {
          name: form.elements.name.value,
          kind,
          parent_id: form.elements.parent.value
            ? +form.elements.parent.value
            : null,
          mastery_target: kind === "deck" ? +form.elements.target.value : 5,
          mastery_mode: kind === "deck" ? form.elements.mode.value : "total",
        },
      );
      await load();
      activeId = node?.id || saved.id;
      resetFilters();
      close();
      view = "library";
      render();
      toast(label + "を保存しました");
    } catch (error) {
      $("#form-error").textContent = error.message;
      button.disabled = false;
    }
  };
  if (node)
    $("#delete-collection").onclick = async () => {
      if (!confirm("空の" + label + "を削除しますか？")) return;
      try {
        await api("collections/" + node.id, "DELETE");
        await load();
        close();
        render();
        toast(label + "を削除しました");
      } catch (error) {
        $("#form-error").textContent = error.message;
      }
    };
}
function questionImage(q) {
  return q.image_id
    ? `<figure class="question-image"><button type="button" data-image="${esc(q.image_id)}" aria-label="問題の画像を拡大"><img src="/api/images/${esc(q.image_id)}" alt="問題の添付画像"></button><figcaption>クリックして拡大</figcaption></figure>`
    : "";
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-image]");
  if (!button) return;
  const { dialog } = modal(
    `<div class="modal-heading"><h2>問題の画像</h2><button type="button" class="icon-button" data-close aria-label="閉じる">×</button></div><img src="/api/images/${esc(button.dataset.image)}" alt="問題の添付画像（拡大）">`,
  );
  dialog.classList.add("image-viewer");
});
function editor(q) {
  const decks = nodes.filter((n) => n.kind === "deck");
  const chosenTags = new Set(q?.tags || []);
  let imageValue = q?.image_id || null,
    imageReading = false,
    imageToken = 0;
  const { dialog, close } = modal(
    `<form id="question-form"><div class="modal-heading"><div><span class="eyebrow">QUESTION EDITOR</span><h2>${q ? "問題を編集" : "問題集に問題を追加"}</h2></div><button type="button" class="icon-button" data-close aria-label="閉じる">×</button></div><label class="field">保存先の問題集<select name="deck" required>${decks.map((d) => `<option value="${d.id}" ${(q?.deck_id ?? activeId) === d.id ? "selected" : ""}>${esc(pathFor(d))}</option>`).join("")}</select></label><label class="field">問題文<textarea name="title" required maxlength="10000" rows="4" placeholder="ここに問題文を入力してください">${esc(q?.title || "")}</textarea></label><div class="field">問題の画像 <span class="optional">任意・1枚</span><small>PNG・JPEG・WebP、5MB以下。クリックで拡大できます。</small><input type="file" id="question-image-file" accept="image/png,image/jpeg,image/webp" aria-label="問題の画像を選択"><div id="image-preview"></div><button type="button" class="text-button" id="remove-image">画像を外す</button><p id="image-error" role="alert"></p></div><div class="field">選択肢<small>正解の選択肢にチェックしてください（単一選択）</small><div id="options"></div><button type="button" class="text-button" id="add-option">＋ 選択肢を追加</button></div><label class="field">解説 <span class="optional">任意</span><textarea name="explanation" maxlength="10000" rows="3" placeholder="正解の理由、覚えておきたいポイント">${esc(q?.explanation || "")}</textarea></label><div class="field">タグ <span class="optional">任意</span><small>登録済みのタグは、クリックで付け外しできます。</small><div class="tag-input"><input id="new-tag" maxlength="50" placeholder="新しいタグを入力"><button class="secondary" type="button" id="add-tag">追加</button></div><div id="tag-choices" class="tag-choices"></div></div>${q ? '<p class="edit-note">問題文・画像・選択肢・正解を変更すると、この問題の学習カウントをリセットします。タグ・解説・保存先の変更では維持します。</p>' : ""}<p id="form-error" role="alert"></p><div class="modal-footer">${q ? '<div class="question-danger-actions"><button type="button" class="danger" id="delete">問題を削除</button><button type="button" class="text-button" id="reset-progress">学習カウントをリセット</button></div>' : "<span></span>"}<div><button type="button" class="secondary" data-close>キャンセル</button><button class="primary" type="submit">${q ? "変更を保存" : "問題を保存"}</button></div></div></form>`,
  );
  function drawImage() {
    $("#image-preview").innerHTML = imageValue
      ? `<img src="${esc(typeof imageValue === "string" ? "/api/images/" + imageValue : imageValue.data_url)}" alt="添付画像のプレビュー">`
      : "";
    $("#remove-image").hidden = !imageValue;
  }
  drawImage();
  $("#remove-image").onclick = () => {
    imageToken++;
    imageReading = false;
    imageValue = null;
    $("#question-image-file").value = "";
    $("#image-error").textContent = "";
    dialog.querySelector("[type=submit]").disabled = false;
    drawImage();
  };
  $("#question-image-file").onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const token = ++imageToken;
    imageReading = true;
    dialog.querySelector("[type=submit]").disabled = true;
    $("#image-error").textContent = "";
    try {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
        throw Error("PNG・JPEG・WebP を選んでください");
      if (file.size > 5 * 1024 * 1024)
        throw Error("画像は5MB以下にしてください");
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(Error("画像を読み込めませんでした"));
        reader.readAsDataURL(file);
      });
      const image = new Image();
      image.src = dataURL;
      await image.decode();
      if (
        image.width > 10000 ||
        image.height > 10000 ||
        image.width * image.height > 25000000
      )
        throw Error("画像は縦横10000px以下、2500万画素以下にしてください");
      if (token !== imageToken || !dialog.isConnected) return;
      imageValue = { data_url: dataURL };
      drawImage();
    } catch (error) {
      if (token === imageToken && dialog.isConnected) {
        $("#image-error").textContent =
          error.message || "画像を読み込めませんでした";
        $("#question-image-file").value = "";
      }
    } finally {
      if (token === imageToken && dialog.isConnected) {
        imageReading = false;
        dialog.querySelector("[type=submit]").disabled = false;
      }
    }
  };
  let available = [...new Set([...tags, ...chosenTags])];
  function drawTags() {
    $("#tag-choices").innerHTML =
      available
        .map(
          (t, i) =>
            `<button type="button" data-tag="${i}" class="tag-choice ${chosenTags.has(t) ? "chosen" : ""}" aria-pressed="${chosenTags.has(t)}">${chosenTags.has(t) ? "✓" : "＋"} ${esc(t)}</button>`,
        )
        .join("") || "<p>追加したタグが、次回からここに表示されます。</p>";
    document.querySelectorAll("[data-tag]").forEach(
      (b) =>
        (b.onclick = () => {
          const t = available[+b.dataset.tag];
          chosenTags.has(t) ? chosenTags.delete(t) : chosenTags.add(t);
          drawTags();
        }),
    );
  }
  drawTags();
  function addTag() {
    const input = $("#new-tag"),
      value = input.value.trim().normalize("NFKC");
    if (!value) return;
    if (chosenTags.size >= 30 && !chosenTags.has(value))
      return toast("タグは30個までです");
    if (!available.includes(value)) available.push(value);
    chosenTags.add(value);
    input.value = "";
    drawTags();
    input.focus();
  }
  $("#add-tag").onclick = addTag;
  $("#new-tag").onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  };
  function addOption(value = "", correct = false) {
    const row = document.createElement("div");
    row.className = "option-edit";
    row.innerHTML = `<input type="radio" name="answer" aria-label="正解に設定" required ${correct ? "checked" : ""}><input class="option-text" required maxlength="2000" placeholder="選択肢を入力" value="${esc(value)}"><button type="button" aria-label="選択肢を削除" class="icon-button">×</button>`;
    row.querySelector("button").onclick = () => {
      if ($("#options").children.length <= 2)
        return toast("選択肢は2つ以上必要です");
      row.remove();
    };
    $("#options").append(row);
  }
  (q?.options || ["", "", "", ""]).forEach((v, i) =>
    addOption(v, i === (q?.answer ?? 0)),
  );
  $("#add-option").onclick = () => {
    if ($("#options").children.length >= 6) return toast("選択肢は6つまでです");
    addOption();
  };
  $("#question-form").onsubmit = async (e) => {
    e.preventDefault();
    if (imageReading) return;
    const form = e.target;
    const rows = [...dialog.querySelectorAll(".option-edit")],
      button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const payload = {
        deck_id: +form.elements.deck.value,
        title: form.elements.title.value,
        explanation: form.elements.explanation.value,
        tags: [...chosenTags],
        image: imageValue,
        options: rows.map((r) => r.querySelector(".option-text").value),
        answer: rows.findIndex((r) => r.querySelector("[type=radio]").checked),
      };
      if (
        q &&
        (q.title !== payload.title.trim() ||
          JSON.stringify(q.options) !==
            JSON.stringify(payload.options.map((v) => v.trim())) ||
          q.answer !== payload.answer ||
          imageValue !== (q.image_id || null)) &&
        q.answer_count &&
        !confirm(
          "問題の内容を変更すると学習カウントがリセットされます。保存しますか？",
        )
      ) {
        button.disabled = false;
        return;
      }
      await api(
        "questions" + (q ? "/" + q.id : ""),
        q ? "PUT" : "POST",
        payload,
      );
      await load();
      activeId = payload.deck_id;
      close();
      render();
      toast("問題を保存しました");
    } catch (error) {
      $("#form-error").textContent = error.message;
      button.disabled = false;
    }
  };
  if (q) {
    $("#delete").onclick = async () => {
      if (!confirm("この問題を削除しますか？ 受験履歴は残ります。")) return;
      try {
        await api("questions/" + q.id, "DELETE");
        selected.delete(q.id);
        await load();
        close();
        render();
        toast("問題を削除しました");
      } catch (error) {
        $("#form-error").textContent = error.message;
      }
    };
    $("#reset-progress").onclick = async () => {
      if (
        !confirm(
          "この問題の回答回数・正解回数を0に戻して、学習中に戻しますか？ 過去の受験履歴は残ります。",
        )
      )
        return;
      try {
        await api("questions/" + q.id + "/reset", "POST", {});
        await load();
        close();
        statusFilter = "learning";
        render();
        toast("学習カウントをリセットしました");
      } catch (error) {
        $("#form-error").textContent = error.message;
      }
    };
  }
}
function startExam(items) {
  if (!items.length) return toast("出題できる問題がありません");
  exam = {
    items,
    answers: items.map(() => null),
    flags: [],
    revealed: items.map(() => false),
    index: 0,
    started: Date.now(),
    key: crypto.randomUUID(),
  };
  result = null;
  render();
  clearInterval(timer);
  timer = setInterval(updateClock, 1000);
}
function updateClock() {
  if ($("#clock") && exam) {
    const s = Math.floor((Date.now() - exam.started) / 1000);
    $("#clock").textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
}
function renderExam() {
  const q = exam.items[exam.index],
    answered = exam.answers.filter((a) => a !== null).length;
  const revealed = exam.revealed[exam.index];
  $("#app").innerHTML =
    `<div class="exam"><header class="exam-header"><span class="exam-brand">Q <b>QuizeLab</b><small>確認テスト</small></span><span>経過時間 <b id="clock">00:00</b></span><button class="secondary" id="quit">テストを中断</button></header><div class="exam-layout"><section class="exam-paper"><div class="exam-meta"><span>問 ${exam.index + 1} <small>/ ${exam.items.length}</small></span><span>${esc(q.category)}</span></div><h1 class="exam-question">${esc(q.title)}</h1>${questionImage(q)}<p class="answer-instruction">最も適切なものを1つ選んでください。</p><div class="exam-options">${q.options.map((o, i) => `<label class="exam-option ${exam.answers[exam.index] === i ? "chosen" : ""}"><input type="radio" name="exam-answer" value="${i}" ${revealed ? "disabled" : ""} ${exam.answers[exam.index] === i ? "checked" : ""}><span>${letters[i]}</span><div>${esc(o)}</div></label>`).join("")}</div><div class="answer-check"><button type="button" class="secondary" id="show-answer" ${exam.answers[exam.index] === null || revealed ? "disabled" : ""} aria-controls="answer-feedback" aria-expanded="${revealed}">${revealed ? "正解を表示済み" : "正解・解説を見る"}</button><span>${revealed ? "確認後は解答を変更できません。" : "解答を選んでから確認できます。"}</span></div>${revealed ? `<section id="answer-feedback" class="answer-feedback" role="status"><strong class="${exam.answers[exam.index] === q.answer ? "correct" : "incorrect"}">${exam.answers[exam.index] === q.answer ? "✓ 正解です" : "× 不正解です"}</strong><p class="correct-answer"><b>正解：${letters[q.answer]}</b> ${esc(q.options[q.answer])}</p><div class="explanation"><b>解説</b><p>${esc(q.explanation || "解説はまだ登録されていません。")}</p></div><small>学習記録は「テストを終了・採点」で保存されます。</small></section>` : ""}<div class="exam-controls"><button class="secondary" id="prev" ${exam.index === 0 ? "disabled" : ""}>← 前の問題</button><button class="text-button" id="flag">${exam.flags.includes(exam.index) ? "◆ 見直しを解除" : "◇ あとで見直す"}</button><button class="primary" id="next">${exam.index === exam.items.length - 1 ? "解答を提出" : "次の問題 →"}</button></div></section><aside class="exam-nav"><h3>解答状況</h3><p>${answered} / ${exam.items.length} 問 解答済み</p><progress value="${answered}" max="${exam.items.length}"></progress><div class="number-grid">${exam.items.map((_, i) => `<button data-jump="${i}" class="${i === exam.index ? "current" : ""} ${exam.answers[i] !== null ? "answered" : ""}">${i + 1}${exam.flags.includes(i) ? "<sup>◆</sup>" : ""}</button>`).join("")}</div><small>◆ あとで見直す問題</small><button id="submit" class="secondary">テストを終了・採点</button><p class="muted">正解を確認する前なら解答を変更できます。未解答の問題は不正解になります。</p><p id="exam-error" role="alert"></p></aside></div></div>`;
  updateClock();
  document.querySelectorAll('[name="exam-answer"]').forEach(
    (r) =>
      (r.onchange = () => {
        if (exam.revealed[exam.index]) return;
        exam.answers[exam.index] = +r.value;
        renderExam();
      }),
  );
  document.querySelectorAll("[data-jump]").forEach(
    (b) =>
      (b.onclick = () => {
        exam.index = +b.dataset.jump;
        renderExam();
      }),
  );
  $("#prev").onclick = () => {
    exam.index--;
    renderExam();
  };
  $("#next").onclick = () => {
    if (exam.index === exam.items.length - 1) submit();
    else {
      exam.index++;
      renderExam();
    }
  };
  $("#show-answer").onclick = () => {
    if (exam.answers[exam.index] === null || exam.revealed[exam.index]) return;
    exam.revealed[exam.index] = true;
    renderExam();
  };
  $("#submit").onclick = submit;
  $("#flag").onclick = () => {
    const i = exam.flags.indexOf(exam.index);
    i < 0 ? exam.flags.push(exam.index) : exam.flags.splice(i, 1);
    renderExam();
  };
  $("#quit").onclick = () => {
    if (confirm("テストを中断しますか？ 途中の解答は保存されません。")) {
      clearInterval(timer);
      exam = null;
      render();
    }
  };
}
async function submit() {
  if (submitting) return;
  const missing = exam.answers.filter((a) => a === null).length;
  if (
    !confirm(
      missing
        ? `未解答が${missing}問あります。採点しますか？`
        : "解答を提出して採点しますか？",
    )
  )
    return;
  submitting = true;
  $("#submit").disabled = true;
  $("#next").disabled = true;
  try {
    const r = await api("attempts", "POST", {
      ids: exam.items.map((q) => q.id),
      answers: exam.answers,
      submission_key: exam.key,
    });
    result = { ...r, answers: [...exam.answers] };
    clearInterval(timer);
    exam = null;
    try {
      await load();
    } catch {
      toast("採点は保存しました。問題集の再読み込みに失敗しました。");
    }
    render();
  } catch (error) {
    $("#exam-error").textContent = error.message;
    $("#submit").disabled = false;
    $("#next").disabled = false;
  } finally {
    submitting = false;
  }
}
function renderResult() {
  const r = result;
  $("#app").innerHTML =
    `<div class="results"><div class="eyebrow">SESSION COMPLETE</div><h1>テスト結果</h1><p>おつかれさまでした。解説を読んで、理解を深めましょう。</p><div class="score"><strong>${Math.round((r.score / r.total) * 100)}<small>%</small></strong><span>正答率 · ${r.total} 問中 ${r.score} 問正解</span></div><div class="result-actions"><button class="secondary" id="home">問題集に戻る</button><button class="primary" id="retry" ${r.score === r.total ? "disabled" : ""}>間違えた問題をもう一度</button></div>${r.questions.map((q, i) => `<article class="review"><div class="review-heading"><span class="${q.answer === r.answers[i] ? "correct" : "incorrect"}">${q.answer === r.answers[i] ? "✓ 正解" : "× 不正解"}</span><span>問 ${i + 1} · ${esc(q.category)}</span></div><h3>${esc(q.title)}</h3>${questionImage(q)}<div class="result-progress">${q.mastered ? "✓ 習得済み" : "習得まで"} · ${q.mastery_mode === "streak" ? "連続" : "累計"} ${q.progress_count} / ${q.mastery_target} 回正解</div>${q.options.map((o, j) => `<div class="review-option ${j === q.answer ? "right" : ""}"><b>${letters[j]}</b> ${esc(o)} ${j === q.answer ? "<small>正解</small>" : j === r.answers[i] ? "<small>あなたの解答</small>" : ""}</div>`).join("")}${r.answers[i] === null ? '<p class="incorrect">未解答</p>' : ""}<div class="explanation"><b>解説</b><p>${esc(q.explanation || "解説はまだ登録されていません。")}</p></div></article>`).join("")}</div>`;
  $("#home").onclick = () => {
    result = null;
    render();
  };
  $("#retry").onclick = () => {
    const items = r.questions
      .filter(
        (q, i) =>
          q.answer !== r.answers[i] &&
          questions.some((current) => current.id === q.id),
      )
      .map((q) => questions.find((current) => current.id === q.id));
    if (!items.length) return toast("再受験できる問題がありません");
    startExam(items);
  };
}
function renderHistory() {
  shell(
    `<section class="page"><div class="eyebrow">YOUR LEARNING JOURNEY</div><div class="page-heading"><div><h1>学習履歴</h1><p>積み重ねた学習を、振り返りましょう。</p></div></div><div class="history-panel">${history.length ? history.map((a) => `<div class="history-row"><span class="history-symbol">✓</span><div><strong>確認テスト</strong><p>${new Date(a.created_at.replace(" ", "T") + "Z").toLocaleString("ja-JP")}</p></div><span>${a.total} 問中 ${a.score} 問正解</span><b>${Math.round((a.score / a.total) * 100)}<small>%</small></b></div>`).join("") : '<div class="empty"><div class="empty-icon">◷</div><h2>学習の記録はこれから</h2><p>問題ライブラリからテストを始めると、<br>ここに結果が記録されます。</p></div>'}</div></section>`,
  );
}
window.addEventListener("beforeunload", (e) => {
  if (exam) {
    e.preventDefault();
    e.returnValue = "";
  }
});
load()
  .then(render)
  .catch((e) => {
    $("#app").textContent = "読み込みに失敗しました：" + e.message;
  });
