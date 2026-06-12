const BANK = window.QUIZ_BANK;
const STORE_KEY = "quiz-site-29-progress-v1";

const TYPE_LABELS = {
  fill: "填空",
  single: "单选",
  multiple: "多选",
  judge: "判断",
  short: "简答",
};

const MODE_TITLES = {
  practice: "顺序练习",
  random: "随机刷题",
  exam: "模拟考试",
  wrong: "错题本",
  favorite: "收藏夹",
  knowledge: "知识点",
};

const TYPE_COLORS = {
  fill: "gold",
  single: "green",
  multiple: "green",
  judge: "",
  short: "red",
};

const qMap = new Map(BANK.questions.map((question) => [question.id, question]));
const originalOrder = new Map(BANK.questions.map((question, index) => [question.id, index]));

let store = loadStore();
let view = {
  mode: store.lastMode || "practice",
  type: "all",
  query: "",
  currentId: store.lastQuestionId || BANK.questions[0]?.id,
  randomOrder: [],
  drafts: {},
  revealed: {},
  exam: null,
};

let timerHandle = null;

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY));
    return {
      version: 1,
      progress: {},
      favorites: {},
      notes: {},
      ...parsed,
    };
  } catch {
    return { version: 1, progress: {}, favorites: {}, notes: {} };
  }
}

function saveStore() {
  store.updatedAt = new Date().toISOString();
  store.lastMode = view.mode;
  store.lastQuestionId = view.currentId;
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function compact(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[，,。．.、；;：:！!？?\s（）()《》<>“”"‘’'_\-—]/g, "");
}

function renderPrompt(value) {
  return escapeHtml(value).replaceAll("____", '<span class="blank" aria-label="填空"></span>');
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function sameSet(left, right) {
  const a = [...left].sort().join("");
  const b = [...right].sort().join("");
  return a === b;
}

function fillCorrect(input, answers) {
  const value = compact(input);
  return answers.every((answer) => value.includes(compact(answer)));
}

function getProgress(id) {
  return store.progress[id] || null;
}

function isWrong(id) {
  const progress = getProgress(id);
  return Boolean(progress && progress.attempts > 0 && progress.lastCorrect === false);
}

function isDone(id) {
  return Boolean(getProgress(id)?.attempts);
}

function favoriteIds() {
  return new Set(Object.keys(store.favorites).filter((id) => store.favorites[id]));
}

function recordProgress(question, correct, selected, mode = "practice") {
  const previous = store.progress[question.id] || {
    attempts: 0,
    correctAttempts: 0,
    wrongAttempts: 0,
  };

  const next = {
    ...previous,
    attempts: previous.attempts + 1,
    correctAttempts: previous.correctAttempts + (correct ? 1 : 0),
    wrongAttempts: previous.wrongAttempts + (correct ? 0 : 1),
    lastCorrect: Boolean(correct),
    lastSelected: selected,
    lastAt: new Date().toISOString(),
    lastMode: mode,
  };

  store.progress[question.id] = next;
  saveStore();
}

function answerText(question) {
  if (question.type === "single" || question.type === "multiple") {
    const labels = question.answer.join("、");
    const copies = question.answer
      .map((label) => `${label}. ${question.options[label] || ""}`)
      .join("；");
    return `${labels}${copies ? "｜" + copies : ""}`;
  }
  if (question.type === "judge") {
    return question.answer ? "√" : "×";
  }
  if (Array.isArray(question.answer)) {
    return question.answer.join("；");
  }
  return question.answer || "";
}

function questionHaystack(question) {
  return compact(
    [
      question.id,
      question.section,
      question.prompt,
      question.original,
      answerText(question),
      question.options ? Object.values(question.options).join(" ") : "",
    ].join(" ")
  );
}

function visibleQuestions() {
  if (view.mode === "exam" && view.exam?.active) {
    return view.exam.ids.map((id) => qMap.get(id)).filter(Boolean);
  }

  let list = [...BANK.questions];
  if (view.mode === "wrong") {
    list = list.filter((question) => isWrong(question.id));
  }
  if (view.mode === "favorite") {
    const favs = favoriteIds();
    list = list.filter((question) => favs.has(question.id));
  }
  if (view.mode === "knowledge") {
    list = list.filter((question) => question.type === "fill");
  }
  if (view.type !== "all" && view.mode !== "knowledge") {
    list = list.filter((question) => question.type === view.type);
  }
  if (view.query) {
    const needle = compact(view.query);
    list = list.filter((question) => questionHaystack(question).includes(needle));
  }
  if (view.mode === "random") {
    if (!view.randomOrder.length) {
      view.randomOrder = shuffle(BANK.questions.map((question) => question.id));
    }
    const order = new Map(view.randomOrder.map((id, index) => [id, index]));
    list.sort((a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999));
  }
  if (view.mode === "practice") {
    list.sort((a, b) => {
      const aw = isWrong(a.id) ? -1 : 0;
      const bw = isWrong(b.id) ? -1 : 0;
      if (aw !== bw) return aw - bw;
      const ad = isDone(a.id) ? 1 : 0;
      const bd = isDone(b.id) ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return (originalOrder.get(a.id) ?? 0) - (originalOrder.get(b.id) ?? 0);
    });
  }
  return list;
}

function setMode(mode) {
  view.mode = mode;
  view.revealed = {};
  if (mode === "random") {
    view.randomOrder = shuffle(BANK.questions.map((question) => question.id));
  }
  if (mode !== "exam") {
    view.exam = null;
  }
  const first = visibleQuestions()[0];
  view.currentId = first?.id || null;
  saveStore();
  render();
}

function currentQuestion(list = visibleQuestions()) {
  if (!list.length) return null;
  const currentStillVisible = list.find((question) => question.id === view.currentId);
  if (currentStillVisible) return currentStillVisible;
  view.currentId = list[0].id;
  return list[0];
}

function currentIndex(list, id) {
  return Math.max(0, list.findIndex((question) => question.id === id));
}

function stats() {
  const progressEntries = Object.values(store.progress);
  const attemptedQuestions = BANK.questions.filter((question) => isDone(question.id)).length;
  const totalAttempts = progressEntries.reduce((sum, item) => sum + (item.attempts || 0), 0);
  const correctAttempts = progressEntries.reduce((sum, item) => sum + (item.correctAttempts || 0), 0);
  const accuracy = totalAttempts ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
  return {
    attemptedQuestions,
    totalAttempts,
    correctAttempts,
    accuracy,
    wrong: BANK.questions.filter((question) => isWrong(question.id)).length,
    favorite: favoriteIds().size,
  };
}

function renderHeader() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === view.mode);
  });
  document.getElementById("viewTitle").textContent = MODE_TITLES[view.mode] || "刷题";
  document.getElementById("bankMeta").textContent =
    `${BANK.title}｜共 ${BANK.counts.total} 题｜生成于 ${new Date(BANK.generatedAt).toLocaleString()}`;
  document.getElementById("searchInput").value = view.query;
  document.getElementById("typeFilter").value = view.type;
}

function renderStats() {
  const data = stats();
  document.getElementById("accuracyValue").textContent = `${data.accuracy}%`;
  document.getElementById("accuracyDial").style.setProperty("--dial", `${data.accuracy}%`);
  document.getElementById("doneCount").textContent = `${data.attemptedQuestions} / ${BANK.counts.total}`;

  const cards = [
    ["填空", BANK.counts.fill],
    ["选择", BANK.counts.single + BANK.counts.multiple],
    ["判断", BANK.counts.judge],
    ["简答", BANK.counts.short],
    ["错题", data.wrong],
  ];
  document.getElementById("overviewGrid").innerHTML = cards
    .map(
      ([label, value]) => `
        <article class="stat-card">
          <p class="overline">${label}</p>
          <strong>${value}</strong>
        </article>
      `
    )
    .join("");
}

function renderExamIntro() {
  const objectiveCount = BANK.questions.filter((q) => q.type !== "short").length;
  return `
    <div class="exam-box">
      <div>
        <p class="overline">模拟组卷</p>
        <h3>从填空、选择、判断中随机抽题，交卷后统一评分</h3>
        <p class="original-line">当前题库可用于自动评分的题目有 ${objectiveCount} 道；简答题保留在练习模式中自评。</p>
      </div>
      <div class="mini-grid">
        <div class="mini-stat"><span>题量</span><strong>30</strong></div>
        <div class="mini-stat"><span>时长</span><strong>45:00</strong></div>
        <div class="mini-stat"><span>范围</span><strong>随机</strong></div>
        <div class="mini-stat"><span>评分</span><strong>自动</strong></div>
      </div>
      <div class="answer-actions">
        <button class="solid-button" data-action="start-exam" type="button">开始模拟</button>
      </div>
    </div>
  `;
}

function renderExamResult() {
  const exam = view.exam;
  const answers = Object.values(exam.answers);
  const correct = answers.filter((answer) => answer.correct).length;
  const total = exam.ids.length;
  const score = total ? Math.round((correct / total) * 100) : 0;
  return `
    <div class="exam-result">
      <div>
        <p class="overline">交卷结果</p>
        <div class="score-number">${score}</div>
      </div>
      <div class="mini-grid">
        <div class="mini-stat"><span>总题数</span><strong>${total}</strong></div>
        <div class="mini-stat"><span>答对</span><strong>${correct}</strong></div>
        <div class="mini-stat"><span>答错</span><strong>${total - correct}</strong></div>
        <div class="mini-stat"><span>用时</span><strong>${formatDuration(Math.floor((exam.submittedAt - exam.startedAt) / 1000))}</strong></div>
      </div>
      <div class="answer-actions">
        <button class="solid-button" data-action="start-exam" type="button">重新组卷</button>
        <button class="ghost-button" data-action="review-exam" type="button">查看本卷</button>
      </div>
    </div>
  `;
}

function renderQuestion() {
  const panel = document.getElementById("questionPanel");
  if (view.mode === "exam" && !view.exam?.active) {
    panel.innerHTML = renderExamIntro();
    stopTimer();
    return;
  }
  if (view.mode === "exam" && view.exam?.submitted) {
    panel.innerHTML = renderExamResult();
    stopTimer();
    return;
  }

  const list = visibleQuestions();
  const question = currentQuestion(list);
  if (!question) {
    panel.innerHTML = `
      <div class="empty-state">
        <div>
          <h3>这里暂时没有题目</h3>
          <p class="original-line">换一个题型、清空搜索词，或者回到顺序练习继续。</p>
        </div>
      </div>
    `;
    stopTimer();
    return;
  }

  const index = currentIndex(list, question.id);
  const favorite = Boolean(store.favorites[question.id]);
  const progress = getProgress(question.id);
  const isExam =
    view.mode === "exam" && view.exam?.active && !view.exam.submitted && !view.exam.reviewing;

  panel.innerHTML = `
    <article class="question-card" data-qid="${question.id}">
      ${isExam ? renderExamTop() : ""}
      <div class="question-topline">
        <div class="badges">
          <span class="badge ${TYPE_COLORS[question.type] || ""}">${TYPE_LABELS[question.type]}</span>
          <span class="badge">${question.id}</span>
          <span class="badge">第 ${index + 1} / ${list.length} 题</span>
          ${progress?.attempts ? `<span class="badge ${progress.lastCorrect ? "green" : "red"}">${progress.lastCorrect ? "上次答对" : "上次答错"}</span>` : ""}
        </div>
        <button class="icon-button" data-action="favorite" data-qid="${question.id}" type="button" title="收藏">${favorite ? "★" : "☆"}</button>
      </div>

      <div class="question-text">${renderPrompt(question.prompt)}</div>
      ${renderAnswerArea(question, isExam)}
      ${isExam ? "" : renderNote(question)}
      <div class="card-footer">
        <div class="pager">
          <button class="ghost-button" data-action="prev" type="button">上一题</button>
          <button class="ghost-button" data-action="next" type="button">下一题</button>
        </div>
        <div class="pager">
          ${view.mode === "random" ? `<button class="ghost-button" data-action="shuffle-one" type="button">换题</button>` : ""}
          ${isExam ? `<button class="danger-button" data-action="submit-exam" type="button">交卷</button>` : ""}
        </div>
      </div>
    </article>
  `;

  if (isExam) startTimer();
  else stopTimer();
}

function renderExamTop() {
  const answered = Object.keys(view.exam.answers).length;
  return `
    <div class="exam-top">
      <div>
        <p class="overline">模拟考试进行中</p>
        <strong>${answered} / ${view.exam.ids.length} 已保存</strong>
      </div>
      <div class="timer" id="examTimer">${remainingExamTime()}</div>
    </div>
  `;
}

function renderAnswerArea(question, isExam) {
  if (question.type === "single" || question.type === "multiple") {
    return renderChoice(question, isExam);
  }
  if (question.type === "judge") {
    return renderJudge(question, isExam);
  }
  if (question.type === "fill") {
    return renderFill(question, isExam);
  }
  return renderShort(question);
}

function draftFor(question) {
  if (view.mode === "exam" && view.exam?.active) {
    return view.exam.answers[question.id]?.selected ?? view.drafts[question.id];
  }
  return view.drafts[question.id] ?? getProgress(question.id)?.lastSelected;
}

function resultVisible(question) {
  if (view.mode === "exam" && view.exam?.active && !view.exam.submitted && !view.exam.reviewing) {
    return false;
  }
  if (view.revealed[question.id] === false) return false;
  return Boolean(view.revealed[question.id] || getProgress(question.id)?.lastAt);
}

function renderChoice(question, isExam) {
  const selected = new Set(draftFor(question) || []);
  const result = resultVisible(question) ? getProgress(question.id) : null;
  const options = Object.entries(question.options)
    .map(([label, copy]) => {
      const isAnswer = question.answer.includes(label);
      const isSelected = selected.has(label);
      const stateClass = result
        ? isAnswer
          ? "is-correct"
          : isSelected
            ? "is-wrong"
            : ""
        : isSelected
          ? "is-selected"
          : "";
      return `
        <button class="option-button ${stateClass}" data-action="toggle-option" data-qid="${question.id}" data-label="${label}" type="button">
          <span class="option-label">${label}</span>
          <span class="option-copy">${escapeHtml(copy)}</span>
        </button>
      `;
    })
    .join("");

  return `
    <div class="options-grid">${options}</div>
    <div class="answer-actions">
      <button class="solid-button" data-action="${isExam ? "save-exam-answer" : "submit-choice"}" data-qid="${question.id}" type="button">
        ${isExam ? "保存作答" : "提交答案"}
      </button>
      ${isExam ? "" : `<button class="ghost-button" data-action="reveal" data-qid="${question.id}" type="button">显示答案</button>`}
    </div>
    ${result ? renderResult(question, result.lastCorrect) : ""}
  `;
}

function renderJudge(question, isExam) {
  const selected = draftFor(question);
  const result = resultVisible(question) ? getProgress(question.id) : null;
  return `
    <div class="truth-grid">
      <button class="truth-button ${selected === true ? "is-selected" : ""}" data-action="toggle-judge" data-qid="${question.id}" data-value="true" type="button">√</button>
      <button class="truth-button ${selected === false ? "is-selected" : ""}" data-action="toggle-judge" data-qid="${question.id}" data-value="false" type="button">×</button>
    </div>
    <div class="answer-actions">
      <button class="solid-button" data-action="${isExam ? "save-exam-answer" : "submit-judge"}" data-qid="${question.id}" type="button">
        ${isExam ? "保存作答" : "提交答案"}
      </button>
      ${isExam ? "" : `<button class="ghost-button" data-action="reveal" data-qid="${question.id}" type="button">显示答案</button>`}
    </div>
    ${result ? renderResult(question, result.lastCorrect) : ""}
  `;
}

function renderFill(question, isExam) {
  const selected = draftFor(question) || "";
  const result = resultVisible(question) ? getProgress(question.id) : null;
  return `
    <textarea class="answer-input" data-draft="${question.id}" placeholder="在这里输入你的答案">${escapeHtml(selected)}</textarea>
    <div class="answer-actions">
      <button class="solid-button" data-action="${isExam ? "save-exam-answer" : "submit-fill"}" data-qid="${question.id}" type="button">
        ${isExam ? "保存作答" : "提交答案"}
      </button>
      ${isExam ? "" : `<button class="ghost-button" data-action="reveal" data-qid="${question.id}" type="button">显示答案</button>`}
    </div>
    ${result ? renderResult(question, result.lastCorrect) : ""}
  `;
}

function renderShort(question) {
  const selected = draftFor(question) || "";
  const result = resultVisible(question) ? getProgress(question.id) : null;
  return `
    <textarea class="answer-input" data-draft="${question.id}" placeholder="先自己默写，再对照答案自评">${escapeHtml(selected)}</textarea>
    <div class="answer-actions">
      <button class="ghost-button" data-action="reveal" data-qid="${question.id}" type="button">显示答案</button>
      <button class="solid-button" data-action="self-mark" data-qid="${question.id}" data-correct="true" type="button">记住了</button>
      <button class="danger-button" data-action="self-mark" data-qid="${question.id}" data-correct="false" type="button">还需复习</button>
    </div>
    ${result || view.revealed[question.id] ? renderResult(question, result?.lastCorrect) : ""}
  `;
}

function renderResult(question, correct) {
  const showCorrect = correct === true;
  const showWrong = correct === false;
  return `
    <div class="result-box ${showCorrect ? "correct" : showWrong ? "wrong" : ""}">
      <p class="answer-line"><strong>${showCorrect ? "答对了" : showWrong ? "需要再看一遍" : "参考答案"}：</strong>${escapeHtml(answerText(question))}</p>
      ${question.original ? `<p class="original-line">原句：${escapeHtml(question.original)}</p>` : ""}
    </div>
  `;
}

function renderNote(question) {
  return `
    <div class="note-box">
      <p class="overline">我的笔记</p>
      <textarea data-note="${question.id}" placeholder="可记录易错点、口诀或补充理解">${escapeHtml(store.notes[question.id] || "")}</textarea>
    </div>
  `;
}

function renderSheet() {
  const list = visibleQuestions();
  const current = currentQuestion(list);
  const done = list.filter((question) => isDone(question.id)).length;
  const wrong = list.filter((question) => isWrong(question.id)).length;
  const favs = favoriteIds();
  const favorites = list.filter((question) => favs.has(question.id)).length;
  const ratio = list.length ? Math.round((done / list.length) * 100) : 0;

  document.getElementById("sheetTitle").textContent = MODE_TITLES[view.mode] || "全部题目";
  document.getElementById("progressFill").style.width = `${ratio}%`;
  document.getElementById("sheetSummary").innerHTML = `
    <div class="sheet-pill"><strong>${done}</strong><span>已练</span></div>
    <div class="sheet-pill"><strong>${wrong}</strong><span>错题</span></div>
    <div class="sheet-pill"><strong>${favorites}</strong><span>收藏</span></div>
  `;

  document.getElementById("questionList").innerHTML = list
    .map((question) => {
      const progress = getProgress(question.id);
      const rowClass = [
        "sheet-row",
        current?.id === question.id ? "is-active" : "",
        progress?.lastCorrect === true ? "is-right" : "",
        progress?.lastCorrect === false ? "is-wrong" : "",
      ].join(" ");
      return `
        <button class="${rowClass}" data-action="jump" data-qid="${question.id}" type="button">
          <span class="status-dot"></span>
          <span class="sheet-id">${question.id}</span>
          <span class="sheet-prompt">${escapeHtml(question.prompt.replaceAll("____", "___"))}</span>
          <span class="sheet-fav">${favs.has(question.id) ? "★" : ""}</span>
        </button>
      `;
    })
    .join("");
}

function render() {
  renderHeader();
  renderStats();
  renderQuestion();
  renderSheet();
  saveStore();
}

function getQuestionFromButton(button) {
  return qMap.get(button.dataset.qid);
}

function updateDraftFromInputs() {
  document.querySelectorAll("[data-draft]").forEach((input) => {
    view.drafts[input.dataset.draft] = input.value;
  });
}

function submitChoice(question, isExam = false) {
  const selected = view.drafts[question.id] || [];
  if (!selected.length) return;
  const correct = sameSet(selected, question.answer);
  if (isExam) {
    view.exam.answers[question.id] = { selected, correct };
  } else {
    recordProgress(question, correct, selected);
    view.revealed[question.id] = true;
  }
}

function submitJudge(question, isExam = false) {
  const selected = view.drafts[question.id];
  if (typeof selected !== "boolean") return;
  const correct = selected === question.answer;
  if (isExam) {
    view.exam.answers[question.id] = { selected, correct };
  } else {
    recordProgress(question, correct, selected);
    view.revealed[question.id] = true;
  }
}

function submitFill(question, isExam = false) {
  const selected = view.drafts[question.id] || "";
  if (!selected.trim()) return;
  const correct = fillCorrect(selected, question.answer);
  if (isExam) {
    view.exam.answers[question.id] = { selected, correct };
  } else {
    recordProgress(question, correct, selected);
    view.revealed[question.id] = true;
  }
}

function saveExamAnswer(question) {
  if (question.type === "single" || question.type === "multiple") submitChoice(question, true);
  if (question.type === "judge") submitJudge(question, true);
  if (question.type === "fill") submitFill(question, true);
  goNext();
}

function reveal(question) {
  view.revealed[question.id] = true;
  if (!getProgress(question.id)) {
    recordProgress(question, false, view.drafts[question.id] ?? "");
  }
}

function goNext() {
  const list = visibleQuestions();
  const question = currentQuestion(list);
  const index = currentIndex(list, question?.id);
  if (index < list.length - 1) {
    view.currentId = list[index + 1].id;
  }
}

function goPrev() {
  const list = visibleQuestions();
  const question = currentQuestion(list);
  const index = currentIndex(list, question?.id);
  if (index > 0) {
    view.currentId = list[index - 1].id;
  }
}

function startExam() {
  const pool = BANK.questions.filter((question) => question.type !== "short");
  const ids = shuffle(pool.map((question) => question.id)).slice(0, Math.min(30, pool.length));
  view.mode = "exam";
  view.exam = {
    active: true,
    submitted: false,
    reviewing: false,
    ids,
    answers: {},
    startedAt: Date.now(),
    durationSec: 45 * 60,
  };
  view.currentId = ids[0];
  view.revealed = {};
}

function submitExam() {
  if (!view.exam?.active || view.exam.submitted) return;
  view.exam.ids.forEach((id) => {
    const question = qMap.get(id);
    const answer = view.exam.answers[id];
    if (!question || !answer) return;
    recordProgress(question, answer.correct, answer.selected, "exam");
  });
  view.exam.submitted = true;
  view.exam.submittedAt = Date.now();
}

function reviewExam() {
  if (!view.exam) return;
  view.exam.submitted = false;
  view.exam.active = true;
  view.exam.reviewing = true;
  view.currentId = view.exam.ids[0];
  Object.keys(view.exam.answers).forEach((id) => {
    view.revealed[id] = true;
  });
}

function remainingExamTime() {
  if (!view.exam?.active) return "00:00";
  const elapsed = Math.floor((Date.now() - view.exam.startedAt) / 1000);
  const remaining = Math.max(0, view.exam.durationSec - elapsed);
  return formatDuration(remaining);
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function startTimer() {
  if (timerHandle) return;
  timerHandle = window.setInterval(() => {
    const timer = document.getElementById("examTimer");
    if (timer) timer.textContent = remainingExamTime();
    if (remainingExamTime() === "00:00") {
      submitExam();
      render();
    }
  }, 1000);
}

function stopTimer() {
  if (timerHandle) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
}

document.getElementById("modeNav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  setMode(button.dataset.mode);
});

document.getElementById("searchInput").addEventListener("input", (event) => {
  view.query = event.target.value;
  view.currentId = visibleQuestions()[0]?.id || null;
  render();
});

document.getElementById("typeFilter").addEventListener("change", (event) => {
  view.type = event.target.value;
  view.currentId = visibleQuestions()[0]?.id || null;
  render();
});

document.getElementById("shuffleBtn").addEventListener("click", () => {
  if (view.mode === "exam") {
    startExam();
  } else {
    view.mode = "random";
    view.randomOrder = shuffle(BANK.questions.map((question) => question.id));
    view.currentId = visibleQuestions()[0]?.id || null;
  }
  render();
});

document.getElementById("compactBtn").addEventListener("click", () => {
  document.querySelector(".sheet-panel").classList.toggle("is-compact");
});

document.getElementById("resetBtn").addEventListener("click", () => {
  if (!confirm("确定清空本地刷题记录吗？题库文件不会受影响。")) return;
  store = { version: 1, progress: {}, favorites: {}, notes: {} };
  view.drafts = {};
  view.revealed = {};
  saveStore();
  render();
});

document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `quiz-progress-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importInput").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    store = {
      version: 1,
      progress: {},
      favorites: {},
      notes: {},
      ...imported,
    };
    saveStore();
    render();
  } catch {
    alert("导入失败：文件不是有效的刷题记录 JSON。");
  } finally {
    event.target.value = "";
  }
});

document.addEventListener("input", (event) => {
  const draft = event.target.closest("[data-draft]");
  if (draft) {
    view.drafts[draft.dataset.draft] = draft.value;
    return;
  }
  const note = event.target.closest("[data-note]");
  if (note) {
    store.notes[note.dataset.note] = note.value;
    saveStore();
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const question = getQuestionFromButton(button);

  updateDraftFromInputs();

  if (action === "toggle-option" && question) {
    const label = button.dataset.label;
    const current = new Set(view.drafts[question.id] || []);
    if (question.type === "single") {
      view.drafts[question.id] = [label];
    } else {
      current.has(label) ? current.delete(label) : current.add(label);
      view.drafts[question.id] = [...current].sort();
    }
    view.revealed[question.id] = false;
  }

  if (action === "toggle-judge" && question) {
    view.drafts[question.id] = button.dataset.value === "true";
    view.revealed[question.id] = false;
  }

  if (action === "submit-choice" && question) submitChoice(question);
  if (action === "submit-judge" && question) submitJudge(question);
  if (action === "submit-fill" && question) submitFill(question);
  if (action === "save-exam-answer" && question) saveExamAnswer(question);

  if (action === "self-mark" && question) {
    const correct = button.dataset.correct === "true";
    recordProgress(question, correct, view.drafts[question.id] || "");
    view.revealed[question.id] = true;
  }

  if (action === "reveal" && question) reveal(question);

  if (action === "favorite" && question) {
    store.favorites[question.id] = !store.favorites[question.id];
    saveStore();
  }

  if (action === "prev") goPrev();
  if (action === "next") goNext();
  if (action === "shuffle-one") {
    view.randomOrder = shuffle(BANK.questions.map((item) => item.id));
    view.currentId = visibleQuestions()[0]?.id || null;
  }
  if (action === "jump" && question) view.currentId = question.id;
  if (action === "start-exam") startExam();
  if (action === "submit-exam") submitExam();
  if (action === "review-exam") reviewExam();

  render();
});

render();
