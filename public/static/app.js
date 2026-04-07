// ==================== DualWrite Pro - Frontend Application ====================
// v2.0 — 샘플 데모 + Diff 시각화 + 성장 트래커 + 체크리스트 예시 + 모바일 최적화

(function() {
  'use strict';

  // ==================== STATE ====================
  var currentUser = null;
  var categories = [];
  var radarChart = null;
  var trendChart = null;
  var categoryChart = null;
  var historyOffset = 0;
  var hasValidApiKey = false;
  var lastOriginalText = '';
  var historyCache = [];
  var API = '';
  var isDemoMode = false;

  // ==================== UTILITY ====================
  function $(id) { return document.getElementById(id); }

  function showToast(msg, type) {
    type = type || 'info';
    var t = $('toast');
    var icon = type === 'success' ? 'check-circle' : type === 'error' ? 'circle-xmark' : 'circle-info';
    t.className = 'toast ' + type;
    t.innerHTML = '<i class="fas fa-' + icon + ' mr-2"></i>' + msg;
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); }, 3500);
  }

  function formatDate(d) {
    if (!d) return '';
    try { return d.replace('T', ' ').substring(0, 16); } catch(e) { return d; }
  }

  function getGrade(score) {
    if (score >= 90) return { label: 'S', cls: 'bg-green-500/20 text-green-300', text: 'score-excellent' };
    if (score >= 75) return { label: 'A', cls: 'bg-lime-500/20 text-lime-300', text: 'score-good' };
    if (score >= 60) return { label: 'B', cls: 'bg-yellow-500/20 text-yellow-300', text: 'score-average' };
    if (score >= 40) return { label: 'C', cls: 'bg-orange-500/20 text-orange-300', text: 'score-average' };
    return { label: 'D', cls: 'bg-red-500/20 text-red-300', text: 'score-poor' };
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ==================== AUTH ====================
  window.enterApp = function() {
    var nickname = $('nicknameInput').value.trim();
    if (!nickname) { showToast('닉네임을 입력해주세요.', 'error'); return; }

    fetch(API + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nickname })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showToast(data.error, 'error'); return; }
      currentUser = data.user;
      $('displayNickname').textContent = currentUser.nickname;
      $('loginModal').classList.add('hidden');
      $('mainApp').classList.remove('hidden');
      isDemoMode = false;
      loadCategories();
      checkApiKeyOnLogin();
    })
    .catch(function(e) { showToast('연결 오류: ' + e.message, 'error'); });
  };

  window.logout = function() {
    currentUser = null;
    isDemoMode = false;
    $('mainApp').classList.add('hidden');
    $('loginModal').classList.remove('hidden');
    $('nicknameInput').value = '';
    // Reset result panels
    $('resultContent').classList.add('hidden');
    $('resultPlaceholder').classList.remove('hidden');
  };

  // ==================== ★ 샘플 데모 원클릭 체험 ====================
  window.tryDemo = function() {
    isDemoMode = true;
    $('loginModal').classList.add('hidden');
    $('mainApp').classList.remove('hidden');
    $('displayNickname').textContent = '체험 모드';

    // Disable history/stats/settings tabs in demo mode
    showToast('샘플 데모 모드입니다. 로그인하면 모든 기능을 사용할 수 있습니다.', 'info');

    // Load demo data
    fetch(API + '/api/demo')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var demo = data.result;
      // Populate textarea with sample original text
      $('inputText').value = demo.original_text;
      $('charCount').textContent = demo.original_text.length;
      $('charBar').style.width = (demo.original_text.length / 3000 * 100) + '%';
      lastOriginalText = demo.original_text;

      // Display result
      displayResult(demo.result);
      showToast('샘플 분석 결과가 로드되었습니다! 실제 분석은 로그인 후 가능합니다.', 'success');
    })
    .catch(function(e) {
      showToast('데모 로드 실패: ' + e.message, 'error');
    });
  };

  // ==================== TABS ====================
  window.switchTab = function(tab) {
    if (isDemoMode && (tab === 'history' || tab === 'stats' || tab === 'settings')) {
      showToast('로그인 후 사용 가능한 기능입니다.', 'error');
      return;
    }
    ['write', 'history', 'stats', 'settings'].forEach(function(t) {
      var panel = $('panel-' + t);
      var btn = $('tab-' + t);
      if (t === tab) {
        panel.classList.remove('hidden');
        panel.classList.add('fade-up');
        btn.classList.add('active');
      } else {
        panel.classList.add('hidden');
        btn.classList.remove('active');
      }
    });
    if (tab === 'history') { historyOffset = 0; loadHistory(); }
    if (tab === 'stats') loadStats();
    if (tab === 'settings') loadApiKeyStatus();
  };

  // ==================== CATEGORIES ====================
  function loadCategories() {
    fetch(API + '/api/categories')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      categories = data.categories || [];
      var sel = $('categorySelect');
      var filter = $('historyFilter');
      sel.innerHTML = '<option value="">선택 안함</option>';
      filter.innerHTML = '<option value="">전체 카테고리</option>';
      categories.forEach(function(c) {
        sel.innerHTML += '<option value="' + c.id + '">' + c.name + '</option>';
        filter.innerHTML += '<option value="' + c.id + '">' + c.name + '</option>';
      });
    });
  }

  // ==================== TEXT INPUT ====================
  document.addEventListener('DOMContentLoaded', function() {
    var inputText = $('inputText');
    if (inputText) {
      inputText.addEventListener('input', function() {
        var len = this.value.length;
        $('charCount').textContent = len;
        $('charBar').style.width = (len / 3000 * 100) + '%';
        if (len > 2700) $('charBar').classList.add('bg-red-500');
        else $('charBar').classList.remove('bg-red-500');
      });
    }
  });

  // ==================== ANALYSIS ====================
  window.analyzeText = function() {
    if (isDemoMode) {
      showToast('실제 분석은 로그인 후 사용 가능합니다. 닉네임으로 로그인해주세요.', 'error');
      return;
    }
    var text = $('inputText').value.trim();
    if (!text) { showToast('글을 입력해주세요.', 'error'); return; }
    if (!currentUser) { showToast('로그인이 필요합니다.', 'error'); return; }
    if (!hasValidApiKey) { showToast('설정 탭에서 API 키를 먼저 등록해주세요.', 'error'); switchTab('settings'); return; }

    lastOriginalText = text;
    var categoryId = $('categorySelect').value;
    var tone = $('toneSelect').value;
    var btn = $('analyzeBtn');

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>AI 분석 중...';
    $('resultPlaceholder').classList.add('hidden');
    $('resultContent').classList.add('hidden');
    $('resultLoading').classList.remove('hidden');

    fetch(API + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text,
        category_id: categoryId ? parseInt(categoryId) : null,
        user_id: currentUser.id,
        tone: tone || null
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        showToast(data.error, 'error');
        $('resultPlaceholder').classList.remove('hidden');
        $('resultLoading').classList.add('hidden');
        return;
      }
      displayResult(data.result);
      showToast('분석이 완료되었습니다!', 'success');
    })
    .catch(function(e) {
      showToast('분석 오류: ' + e.message, 'error');
      $('resultPlaceholder').classList.remove('hidden');
    })
    .finally(function() {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-2"></i>이중 글쓰기 분석';
      $('resultLoading').classList.add('hidden');
    });
  };

  // ==================== DISPLAY RESULT ====================
  function displayResult(result) {
    $('resultContent').classList.remove('hidden');
    $('resultPlaceholder').classList.add('hidden');

    var ai = result.analysis.ai_score || 0;
    var hu = result.analysis.human_score || 0;
    var avg = Math.round((ai + hu) / 2);
    var grade = getGrade(avg);

    $('gradeLabel').className = 'px-3 py-1 rounded-full text-xs font-bold ' + grade.cls;
    $('gradeLabel').textContent = '종합 ' + grade.label + '등급 (' + avg + '점)';

    var circumference = 376.99;
    animateScore('aiScoreNum', ai);
    animateScore('humanScoreNum', hu);

    setTimeout(function() {
      $('aiScoreRing').style.strokeDashoffset = circumference - (circumference * ai / 100);
      $('humanScoreRing').style.strokeDashoffset = circumference - (circumference * hu / 100);
    }, 100);

    // ★ Detail scores — 실제 값 반영
    var ad = result.analysis.ai_details || {};
    var hd = result.analysis.human_details || {};

    setDetailScore('Numbers', ad.numbers || 0, 40, 'blue');
    setDetailScore('Source', ad.source || 0, 30, 'blue');
    setDetailScore('Structure', ad.structure || 0, 30, 'blue');
    setDetailScore('Target', hd.target || 0, 30, 'accent');
    setDetailScore('Value', hd.value || 0, 40, 'accent');
    setDetailScore('Empathy', hd.empathy || 0, 30, 'accent');

    updateRadarChart(ad, hd);

    // Checklist with improvement examples
    var cl = result.checklist || {};
    renderChecklist(cl);

    // Feedback
    var feedbacks = result.analysis.feedback || [];
    renderFeedback(feedbacks);

    // ★ Before/After with DIFF visualization
    $('beforeText').textContent = lastOriginalText;
    renderRevisedText(result.revised_text || '');
    renderDiffView(lastOriginalText, result.revised_text || '');
  }

  // ★ 점수를 실제 값으로 세팅하는 함수
  function setDetailScore(name, score, max, color) {
    var detailEl = $('detail' + name);
    var barEl = $('bar' + name);
    if (detailEl) detailEl.textContent = score + '/' + max;
    if (barEl) {
      setTimeout(function() {
        barEl.style.width = (score / max * 100) + '%';
      }, 200);
    }
  }

  // ==================== ★ CHECKLIST WITH IMPROVEMENT EXAMPLES ====================
  function renderChecklist(cl) {
    var items = [
      {
        key: 'has_numbers', label: '수치 데이터', desc: '%, 금액, 기간 등', icon: 'fa-hashtag',
        example_before: '많은 사람들이 사용하고 있다',
        example_after: '직장인 78%가 주 3회 이상 활용 중이다'
      },
      {
        key: 'has_source', label: '출처 명시', desc: '신뢰 출처, 측정 기간', icon: 'fa-quote-right',
        example_before: '연구에 따르면 효과가 있다고 한다',
        example_after: '한국생산성본부(2026.02) 조사에 따르면'
      },
      {
        key: 'has_target', label: '대상 특정', desc: '누구에게 도움?', icon: 'fa-user-check',
        example_before: '사람들에게 도움이 된다',
        example_after: '매일 3건 이상 보고서를 쓰는 마케터라면'
      },
      {
        key: 'has_benefit', label: '변화 서술', desc: '어떤 변화/혜택?', icon: 'fa-arrow-trend-up',
        example_before: '업무가 편해진다',
        example_after: '보고서 작성 시간이 42% 단축되어 오후 6시 칼퇴 가능'
      },
      {
        key: 'is_head_heavy', label: '두괄식 배치', desc: '핵심 키워드 전면', icon: 'fa-heading',
        example_before: '여러 기능이 있는데 결론적으로 좋다',
        example_after: '업무 생산성 42% 향상 — AI 글쓰기 도구의 핵심 가치'
      }
    ];
    var passCount = 0;
    var html = items.map(function(item) {
      var pass = cl[item.key];
      if (pass) passCount++;
      return '<div class="check-card ' + (pass ? 'pass' : 'fail') + ' rounded-xl p-3">'
        + '<div class="flex items-center gap-3 mb-2">'
        + '<div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ' + (pass ? 'bg-green-500/20' : 'bg-red-500/20') + '">'
        + '<i class="fas ' + (pass ? 'fa-check' : 'fa-xmark') + ' ' + (pass ? 'text-green-400' : 'text-red-400') + '"></i></div>'
        + '<div><div class="text-sm font-medium ' + (pass ? 'text-green-300' : 'text-red-300') + '">' + item.label + '</div>'
        + '<div class="text-[10px] text-gray-500">' + item.desc + '</div></div></div>'
        // ★ Before→After 예시 (미통과 항목에만 표시)
        + (!pass ? '<div class="checklist-example mt-2 pt-2 border-t border-gray-700/30">'
          + '<div class="text-[10px] text-gray-500 mb-1"><i class="fas fa-arrow-right mr-1"></i>개선 예시</div>'
          + '<div class="text-[11px] text-red-400/70 line-through mb-0.5">' + escapeHtml(item.example_before) + '</div>'
          + '<div class="text-[11px] text-green-400 font-medium">' + escapeHtml(item.example_after) + '</div>'
          + '</div>' : '')
        + '</div>';
    }).join('');

    $('checklistArea').innerHTML = html;
    $('checkScore').textContent = passCount + '/' + items.length + ' 통과';
    $('checkScore').className = 'text-sm font-bold ' + (passCount >= 4 ? 'text-green-400' : passCount >= 2 ? 'text-yellow-400' : 'text-red-400');
  }

  function renderFeedback(feedbacks) {
    $('feedbackList').innerHTML = feedbacks.map(function(f, i) {
      return '<div class="slide-in flex items-start gap-3 p-3 rounded-xl bg-navy-900/30 border border-gray-800/30" style="animation-delay:' + (i * 0.1) + 's">'
        + '<div class="w-7 h-7 rounded-lg bg-yellow-500/10 flex items-center justify-center flex-shrink-0 mt-0.5"><i class="fas fa-lightbulb text-yellow-400 text-xs"></i></div>'
        + '<p class="text-sm text-gray-300 leading-relaxed">' + escapeHtml(f) + '</p></div>';
    }).join('');
  }

  // ==================== REVISED TEXT RENDERING ====================
  function renderRevisedText(text) {
    var el = $('revisedText');
    if (!text) { el.innerHTML = '<p class="text-gray-400 italic">교정문이 없습니다.</p>'; return; }

    var paragraphs = text.split(/\n\n+/);

    if (paragraphs.length <= 1) {
      var sentenceRe = /([.!?])\s+/g;
      var sentences = [];
      var lastIndex = 0;
      var match;

      while ((match = sentenceRe.exec(text)) !== null) {
        sentences.push(text.substring(lastIndex, match.index + 1));
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < text.length) {
        sentences.push(text.substring(lastIndex));
      }

      if (sentences.length > 3) {
        var grouped = [];
        for (var i = 0; i < sentences.length; i += 2) {
          var chunk = sentences[i];
          if (i + 1 < sentences.length) chunk += ' ' + sentences[i + 1];
          grouped.push(chunk.trim());
        }
        el.innerHTML = grouped.map(function(p) {
          return '<p>' + highlightKeyElements(p) + '</p>';
        }).join('');
      } else {
        el.innerHTML = '<p>' + highlightKeyElements(text) + '</p>';
      }
    } else {
      el.innerHTML = paragraphs.map(function(p) {
        if (!p.trim()) return '';
        return '<p>' + highlightKeyElements(p.trim()) + '</p>';
      }).join('');
    }
  }

  function highlightKeyElements(text) {
    // Step 1: Escape HTML first to prevent XSS, but text is already plain
    // Step 2: Highlight quotes FIRST (before inserting HTML tags with quotes)
    // Only match Korean-style quotes: '' "" 「」 『』 and single quotes
    var quotePattern = /([\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F][^\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F]+[\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F])/g;
    var result = text.replace(quotePattern, '<span class="hl-quote">$1</span>');
    // Also match '...' single-quoted text (but NOT double quotes to avoid HTML attr conflict)
    var singleQuotePattern = /('(?=[^\s])[^']{2,}[^'\s]')/g;
    result = result.replace(singleQuotePattern, '<span class="hl-quote">$1</span>');
    // Step 3: Highlight numbers with units AFTER quotes (safe because hl-quote uses Unicode chars)
    var numPattern = /(\d+[.,]?\d*\s*[%만원억천달러배건명개월년주일시간분초위개점])/g;
    result = result.replace(numPattern, '<span class="hl-num">$1</span>');
    return result;
  }

  // ==================== ★ DIFF VISUALIZATION ====================
  function renderDiffView(original, revised) {
    var diffContainer = $('diffView');
    if (!diffContainer) return;

    if (!original || !revised) {
      diffContainer.innerHTML = '<p class="text-gray-500 italic text-sm">비교할 텍스트가 없습니다.</p>';
      return;
    }

    // Simple word-level diff
    var origWords = original.replace(/\n/g, ' ').split(/\s+/);
    var revWords = revised.replace(/\n/g, ' ').split(/\s+/);

    // Use LCS-based diff for better accuracy
    var diff = computeDiff(origWords, revWords);
    var html = '';

    diff.forEach(function(item) {
      if (item.type === 'equal') {
        html += '<span class="diff-equal">' + escapeHtml(item.text) + '</span> ';
      } else if (item.type === 'delete') {
        html += '<span class="diff-delete">' + escapeHtml(item.text) + '</span> ';
      } else if (item.type === 'insert') {
        html += '<span class="diff-insert">' + escapeHtml(item.text) + '</span> ';
      }
    });

    // Stats
    var insertCount = diff.filter(function(d) { return d.type === 'insert'; }).length;
    var deleteCount = diff.filter(function(d) { return d.type === 'delete'; }).length;
    var equalCount = diff.filter(function(d) { return d.type === 'equal'; }).length;

    diffContainer.innerHTML = '<div class="diff-stats mb-3">'
      + '<span class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-green-500/10 text-green-400 mr-2"><i class="fas fa-plus"></i> 추가 ' + insertCount + '단어</span>'
      + '<span class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-red-500/10 text-red-400 mr-2"><i class="fas fa-minus"></i> 삭제 ' + deleteCount + '단어</span>'
      + '<span class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-gray-500/10 text-gray-400"><i class="fas fa-equals"></i> 유지 ' + equalCount + '단어</span>'
      + '</div>'
      + '<div class="diff-content">' + html + '</div>';
  }

  // LCS-based simple diff
  function computeDiff(a, b) {
    var m = a.length, n = b.length;
    // For very long arrays, use simplified approach
    if (m > 500 || n > 500) {
      return simpleDiff(a, b);
    }

    var dp = [];
    for (var i = 0; i <= m; i++) {
      dp[i] = [];
      for (var j = 0; j <= n; j++) {
        if (i === 0 || j === 0) dp[i][j] = 0;
        else if (a[i-1] === b[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
        else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
      }
    }

    // Backtrack
    var result = [];
    var ii = m, jj = n;
    while (ii > 0 || jj > 0) {
      if (ii > 0 && jj > 0 && a[ii-1] === b[jj-1]) {
        result.unshift({ type: 'equal', text: a[ii-1] });
        ii--; jj--;
      } else if (jj > 0 && (ii === 0 || dp[ii][jj-1] >= dp[ii-1][jj])) {
        result.unshift({ type: 'insert', text: b[jj-1] });
        jj--;
      } else {
        result.unshift({ type: 'delete', text: a[ii-1] });
        ii--;
      }
    }
    return result;
  }

  function simpleDiff(a, b) {
    var result = [];
    var bSet = {};
    b.forEach(function(w) { bSet[w] = true; });
    var aSet = {};
    a.forEach(function(w) { aSet[w] = true; });

    a.forEach(function(w) {
      if (bSet[w]) result.push({ type: 'equal', text: w });
      else result.push({ type: 'delete', text: w });
    });
    b.forEach(function(w) {
      if (!aSet[w]) result.push({ type: 'insert', text: w });
    });
    return result;
  }

  // ==================== SCORE ANIMATION ====================
  function animateScore(elId, target) {
    var el = $(elId);
    if (!el) return;
    var duration = 1200;
    var startTime = performance.now();

    function update(time) {
      var elapsed = time - startTime;
      var progress = Math.min(elapsed / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(eased * target);
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  // ==================== RADAR CHART ====================
  function updateRadarChart(ai, human) {
    var ctx = $('radarChart');
    if (!ctx) return;
    ctx = ctx.getContext('2d');
    if (radarChart) radarChart.destroy();

    radarChart = new Chart(ctx, {
      type: 'radar',
      data: {
        labels: ['수치 데이터', '출처/기간', '두괄식 구조', '대상 특정', '변화/가치', '공감 묘사'],
        datasets: [{
          label: '종합',
          data: [
            ((ai.numbers || 0) / 40) * 100,
            ((ai.source || 0) / 30) * 100,
            ((ai.structure || 0) / 30) * 100,
            ((human.target || 0) / 30) * 100,
            ((human.value || 0) / 40) * 100,
            ((human.empathy || 0) / 30) * 100
          ],
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168, 85, 247, 0.1)',
          borderWidth: 2,
          pointBackgroundColor: function(ctx) { return ctx.dataIndex < 3 ? '#3b82f6' : '#F97316'; },
          pointBorderColor: function(ctx) { return ctx.dataIndex < 3 ? 'rgba(59,130,246,0.3)' : 'rgba(249,115,22,0.3)'; },
          pointRadius: 5,
          pointHoverRadius: 8,
          pointBorderWidth: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15,23,42,0.9)',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            titleFont: { family: 'Noto Sans KR' },
            bodyFont: { family: 'Noto Sans KR' },
            callbacks: {
              label: function(ctx) {
                var labels = ['수치(AI)', '출처(AI)', '구조(AI)', '대상(Human)', '가치(Human)', '공감(Human)'];
                return labels[ctx.dataIndex] + ': ' + Math.round(ctx.raw) + '%';
              }
            }
          }
        },
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            grid: { color: 'rgba(148,163,184,0.08)' },
            angleLines: { color: 'rgba(148,163,184,0.08)' },
            pointLabels: {
              color: function(ctx) { return ctx.index < 3 ? '#60a5fa' : '#fb923c'; },
              font: { size: 11, weight: '600', family: 'Noto Sans KR' }
            },
            ticks: { display: false, stepSize: 25 }
          }
        }
      }
    });
  }

  // ==================== COPY ====================
  window.copyRevised = function() {
    var text = $('revisedText').textContent;
    navigator.clipboard.writeText(text).then(function() {
      var btn = $('copyBtn');
      btn.innerHTML = '<i class="fas fa-check"></i> 복사 완료!';
      btn.classList.add('bg-green-500/20', 'text-green-400');
      setTimeout(function() {
        btn.innerHTML = '<i class="fas fa-copy"></i> 교정문 복사';
        btn.classList.remove('bg-green-500/20', 'text-green-400');
      }, 2000);
      showToast('교정문이 클립보드에 복사되었습니다', 'success');
    });
  };

  // ==================== ★ DIFF VIEW TOGGLE ====================
  window.toggleDiffView = function() {
    var diffPanel = $('diffPanel');
    var comparisonPanel = $('comparisonPanel');
    var diffBtn = $('diffToggleBtn');

    if (diffPanel.classList.contains('hidden')) {
      diffPanel.classList.remove('hidden');
      comparisonPanel.classList.add('hidden');
      diffBtn.innerHTML = '<i class="fas fa-columns mr-1"></i> 나란히 보기';
      diffBtn.classList.add('bg-purple-500/20', 'text-purple-400');
    } else {
      diffPanel.classList.add('hidden');
      comparisonPanel.classList.remove('hidden');
      diffBtn.innerHTML = '<i class="fas fa-code-compare mr-1"></i> Diff 비교';
      diffBtn.classList.remove('bg-purple-500/20', 'text-purple-400');
    }
  };

  // ==================== HISTORY ====================
  function loadHistory() {
    if (!currentUser) return;
    historyOffset = 0;
    var catId = $('historyFilter').value;
    var url = API + '/api/logs?user_id=' + currentUser.id + '&limit=10&offset=0';
    if (catId) url += '&category_id=' + catId;

    fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var logs = data.logs || [];
      var container = $('historyList');

      if (logs.length === 0) {
        container.innerHTML = '<div class="flex flex-col items-center justify-center py-16 text-gray-500">'
          + '<div class="w-16 h-16 rounded-2xl bg-navy-800/50 flex items-center justify-center mb-4"><i class="fas fa-inbox text-2xl text-gray-600"></i></div>'
          + '<p class="font-medium">교정 이력이 없습니다</p>'
          + '<p class="text-xs text-gray-600 mt-1">글쓰기 분석을 시작하면 이력이 쌓입니다</p></div>';
        $('loadMoreArea').classList.add('hidden');
        return;
      }

      historyCache = logs;
      container.innerHTML = logs.map(function(l, i) { return renderHistoryItem(l, i); }).join('');
      $('loadMoreArea').classList.toggle('hidden', logs.length < 10);
      historyOffset = logs.length;
    });
  }

  window.loadMoreHistory = function() {
    var catId = $('historyFilter').value;
    var url = API + '/api/logs?user_id=' + currentUser.id + '&limit=10&offset=' + historyOffset;
    if (catId) url += '&category_id=' + catId;

    fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var logs = data.logs || [];
      var container = $('historyList');
      container.innerHTML += logs.map(function(l, i) { return renderHistoryItem(l, historyCache.length + i); }).join('');
      historyCache = historyCache.concat(logs);
      $('loadMoreArea').classList.toggle('hidden', logs.length < 10);
      historyOffset += logs.length;
    });
  };

  function renderHistoryItem(log, idx) {
    var aiG = getGrade(log.ai_score);
    var huG = getGrade(log.human_score);
    var avg = Math.round(((log.ai_score || 0) + (log.human_score || 0)) / 2);
    var avgG = getGrade(avg);
    var preview = (log.original_text || '').substring(0, 120);
    var revisedPreview = (log.revised_text || '').substring(0, 120);

    return '<div class="glass-card history-item rounded-2xl p-4 sm:p-5 fade-up" onclick="window.loadFromHistory(' + idx + ')">'
      + '<div class="flex items-center justify-between mb-3 flex-wrap gap-2">'
      + '<div class="flex items-center gap-2 flex-wrap">'
      + (log.category_name ? '<span class="px-2.5 py-1 bg-accent-500/10 text-accent-400 text-[11px] rounded-lg font-medium"><i class="fas fa-folder mr-1"></i>' + log.category_name + '</span>' : '')
      + '<span class="text-[11px] text-gray-500"><i class="fas fa-clock mr-1"></i>' + formatDate(log.created_at) + '</span>'
      + '</div>'
      + '<div class="flex items-center gap-1.5">'
      + '<span class="px-2 py-1 rounded-lg text-[11px] font-bold ' + aiG.cls + '"><i class="fas fa-robot mr-1"></i>' + log.ai_score + '</span>'
      + '<span class="px-2 py-1 rounded-lg text-[11px] font-bold ' + huG.cls + '"><i class="fas fa-heart mr-1"></i>' + log.human_score + '</span>'
      + '<span class="px-2 py-1 rounded-lg text-[11px] font-bold ' + avgG.cls + '">' + avgG.label + '</span>'
      + '</div></div>'
      + '<p class="text-sm text-gray-400 leading-relaxed line-clamp-2 mb-2">' + escapeHtml(preview) + '</p>'
      + (revisedPreview ? '<div class="pt-2 border-t border-gray-800/30"><p class="text-sm text-amber-200/70 leading-relaxed line-clamp-2"><i class="fas fa-wand-magic-sparkles text-accent-500 mr-1.5"></i>' + escapeHtml(revisedPreview) + '</p></div>' : '')
      + '<div class="mt-2 flex items-center justify-between">'
      + '<span class="text-[10px] px-2 py-0.5 rounded-lg ' + mi.bg + ' ' + mi.color + ' font-medium"><i class="fas ' + mi.icon + ' mr-1"></i>' + mi.name + '</span>'
      + '<span class="text-xs text-accent-500/60 hover:text-accent-400 transition-colors"><i class="fas fa-arrow-up-right-from-square mr-1"></i>상세 보기</span>'
      + '</div>'
      + '</div>';
  }

  // ==================== LOAD FROM HISTORY ====================
  window.loadFromHistory = function(idx) {
    var log = historyCache[idx];
    if (!log) { showToast('이력 데이터를 찾을 수 없습니다.', 'error'); return; }

    switchTab('write');

    var textarea = $('inputText');
    textarea.value = log.original_text || '';
    $('charCount').textContent = textarea.value.length;
    $('charBar').style.width = (textarea.value.length / 3000 * 100) + '%';
    lastOriginalText = log.original_text || '';

    $('resultPlaceholder').classList.add('hidden');
    $('resultLoading').classList.add('hidden');
    $('resultContent').classList.remove('hidden');

    var ai = log.ai_score || 0;
    var hu = log.human_score || 0;
    var avg = Math.round((ai + hu) / 2);
    var grade = getGrade(avg);

    $('gradeLabel').className = 'px-3 py-1 rounded-full text-xs font-bold ' + grade.cls;
    $('gradeLabel').textContent = '종합 ' + grade.label + '등급 (' + avg + '점)';

    var circumference = 376.99;
    animateScore('aiScoreNum', ai);
    animateScore('humanScoreNum', hu);

    setTimeout(function() {
      $('aiScoreRing').style.strokeDashoffset = circumference - (circumference * ai / 100);
      $('humanScoreRing').style.strokeDashoffset = circumference - (circumference * hu / 100);
    }, 100);

    // ★ 이력에서 세부 점수 복원 (DB에 저장된 ai_details_json/human_details_json 활용)
    var ad = {};
    var hd = {};
    try {
      ad = typeof log.ai_details_json === 'string' ? JSON.parse(log.ai_details_json) : (log.ai_details_json || {});
      hd = typeof log.human_details_json === 'string' ? JSON.parse(log.human_details_json) : (log.human_details_json || {});
    } catch(e) { /* fallback to empty */ }

    setDetailScore('Numbers', ad.numbers || 0, 40, 'blue');
    setDetailScore('Source', ad.source || 0, 30, 'blue');
    setDetailScore('Structure', ad.structure || 0, 30, 'blue');
    setDetailScore('Target', hd.target || 0, 30, 'accent');
    setDetailScore('Value', hd.value || 0, 40, 'accent');
    setDetailScore('Empathy', hd.empathy || 0, 30, 'accent');

    updateRadarChart(ad, hd);

    // Restore checklist
    try {
      var cl = typeof log.checklist_json === 'string' ? JSON.parse(log.checklist_json) : log.checklist_json;
      if (cl) renderChecklist(cl);
    } catch(e) { /* ignore */ }

    // Restore feedback
    try {
      var feedbacks = typeof log.feedback === 'string' ? JSON.parse(log.feedback) : log.feedback;
      if (feedbacks && Array.isArray(feedbacks)) renderFeedback(feedbacks);
    } catch(e) { /* ignore */ }

    $('beforeText').textContent = log.original_text || '';
    renderRevisedText(log.revised_text || '');
    renderDiffView(log.original_text || '', log.revised_text || '');

    showHistoryModal(log);

    showToast('이력을 불러왔습니다 — ' + (log.category_name || '미분류') + ' (' + formatDate(log.created_at) + ')', 'info');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ==================== HISTORY DETAIL MODAL ====================
  function showHistoryModal(log) {
    var modal = $('historyModal');
    if (!modal) return;

    var ai = log.ai_score || 0;
    var hu = log.human_score || 0;
    var avg = Math.round((ai + hu) / 2);
    var grade = getGrade(avg);

    var originalText = escapeHtml(log.original_text || '');
    var revisedParagraphs = (log.revised_text || '').split(/\n\n+/);
    var revisedHtml;
    if (revisedParagraphs.length <= 1) {
      revisedHtml = '<p>' + highlightKeyElements(log.revised_text || '') + '</p>';
    } else {
      revisedHtml = revisedParagraphs.map(function(p) {
        return '<p>' + highlightKeyElements(p.trim()) + '</p>';
      }).join('');
    }

    $('modalBody').innerHTML = ''
      + '<div class="flex items-center justify-between mb-6 flex-wrap gap-3">'
      + '<div class="flex items-center gap-3">'
      + '<div class="w-12 h-12 rounded-xl bg-gradient-to-br from-accent-500 to-accent-600 flex items-center justify-center"><i class="fas fa-scroll text-white text-lg"></i></div>'
      + '<div><h3 class="text-white font-bold text-lg">교정 이력 상세</h3>'
      + '<p class="text-xs text-gray-400">' + formatDate(log.created_at) + (log.category_name ? ' · ' + log.category_name : '') + '</p></div>'
      + '</div>'
      + '<div class="flex gap-2"><span class="px-3 py-1.5 rounded-xl text-sm font-bold ' + grade.cls + '">' + grade.label + '등급 (' + avg + '점)</span></div>'
      + '</div>'
      // Scores row
      + '<div class="grid grid-cols-2 gap-4 mb-6">'
      + '<div class="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 text-center">'
      + '<div class="text-3xl font-extrabold text-blue-400 stat-num">' + ai + '</div>'
      + '<div class="text-xs text-gray-400 mt-1"><i class="fas fa-robot mr-1"></i>AI 점수</div></div>'
      + '<div class="bg-accent-500/5 border border-accent-500/20 rounded-xl p-4 text-center">'
      + '<div class="text-3xl font-extrabold text-accent-400 stat-num">' + hu + '</div>'
      + '<div class="text-xs text-gray-400 mt-1"><i class="fas fa-heart mr-1"></i>인간 점수</div></div>'
      + '</div>'
      // Original text
      + '<div class="mb-4">'
      + '<div class="flex items-center gap-2 mb-2"><span class="w-2 h-2 bg-gray-400 rounded-full"></span><span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">원문</span></div>'
      + '<div class="before-box text-sm leading-relaxed whitespace-pre-wrap">' + originalText + '</div>'
      + '</div>'
      // Revised text
      + '<div class="mb-4">'
      + '<div class="flex items-center gap-2 mb-2"><span class="w-2 h-2 bg-green-400 rounded-full"></span><span class="text-xs font-semibold text-green-400 uppercase tracking-wider">교정문 (AI 추천)</span>'
      + '<button onclick="window.copyModalRevised()" class="ml-auto text-xs text-accent-400 hover:text-accent-300 transition-colors"><i class="fas fa-copy mr-1"></i>복사</button></div>'
      + '<div class="revised-box" id="modalRevisedText">' + revisedHtml + '</div>'
      + '</div>';

    // Show model info in modal if available
    if (log.model_used) {
      var mi = getModelInfo(log.model_used);
      $('modalBody').innerHTML += '<div class="mt-4 pt-3 border-t border-gray-800/30 flex items-center gap-2">'
        + '<span class="text-[11px] text-gray-500"><i class="fas fa-microchip mr-1"></i>분석 모델:</span>'
        + '<span class="text-[11px] px-2 py-0.5 rounded-lg ' + mi.bg + ' ' + mi.color + ' font-medium"><i class="fas ' + mi.icon + ' mr-1"></i>' + mi.name + '</span>'
        + '</div>';
    }

    modal.classList.add('active');
  }

  window.closeHistoryModal = function() {
    $('historyModal').classList.remove('active');
  };

  window.copyModalRevised = function() {
    var text = $('modalRevisedText').textContent;
    navigator.clipboard.writeText(text).then(function() {
      showToast('교정문이 복사되었습니다', 'success');
    });
  };

  document.addEventListener('DOMContentLoaded', function() {
    var modal = $('historyModal');
    if (modal) {
      modal.addEventListener('click', function(e) {
        if (e.target === modal) window.closeHistoryModal();
      });
    }
  });

  // ==================== ★ STATS WITH GROWTH TRACKER ====================
  function loadStats() {
    if (!currentUser) return;
    fetch(API + '/api/stats?user_id=' + currentUser.id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var s = data.stats || {};
      animateCounter('statTotal', s.total_writes || 0);
      animateCounter('statAvgAI', s.avg_ai_score || 0);
      animateCounter('statAvgHuman', s.avg_human_score || 0);
      updateTrendChart((data.recentTrend || []).reverse());
      updateCategoryChart(data.categoryStats || []);

      // ★ 성장 트래커
      renderGrowthTracker(data.growth, s);
    });
  }

  // ★ 성장 트래커 렌더링
  function renderGrowthTracker(growth, stats) {
    var container = $('growthTracker');
    if (!container) return;

    if (!growth || !growth.first || !growth.last || stats.total_writes < 2) {
      container.innerHTML = '<div class="text-center py-8">'
        + '<div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-500/10 flex items-center justify-center">'
        + '<i class="fas fa-seedling text-2xl text-accent-500"></i></div>'
        + '<p class="text-gray-400 font-medium">분석을 2회 이상 진행하면</p>'
        + '<p class="text-gray-500 text-sm">성장 리포트가 생성됩니다</p>'
        + '</div>';
      return;
    }

    var first = growth.first;
    var last = growth.last;
    var aiDiff = (last.ai_score || 0) - (first.ai_score || 0);
    var huDiff = (last.human_score || 0) - (first.human_score || 0);
    var avgFirst = Math.round(((first.ai_score || 0) + (first.human_score || 0)) / 2);
    var avgLast = Math.round(((last.ai_score || 0) + (last.human_score || 0)) / 2);
    var avgDiff = avgLast - avgFirst;

    var aiArrow = aiDiff > 0 ? 'fa-arrow-up text-green-400' : aiDiff < 0 ? 'fa-arrow-down text-red-400' : 'fa-minus text-gray-400';
    var huArrow = huDiff > 0 ? 'fa-arrow-up text-green-400' : huDiff < 0 ? 'fa-arrow-down text-red-400' : 'fa-minus text-gray-400';
    var avgArrow = avgDiff > 0 ? 'fa-arrow-up text-green-400' : avgDiff < 0 ? 'fa-arrow-down text-red-400' : 'fa-minus text-gray-400';

    // 인사이트 문구 생성
    var insight = '';
    if (avgDiff > 15) insight = '눈에 띄는 성장을 보이고 있습니다! 꾸준히 연습한 결과가 나타나고 있어요.';
    else if (avgDiff > 5) insight = '조금씩 성장하고 있습니다. 수치 데이터와 출처 보강에 집중해 보세요.';
    else if (avgDiff > 0) insight = '소폭 개선되었습니다. 체크리스트 미통과 항목을 집중 개선해 보세요.';
    else if (avgDiff === 0) insight = '점수가 유지 중입니다. 새로운 카테고리에 도전해 보세요.';
    else insight = '점수가 다소 하락했습니다. 성·기·대·변 공식을 다시 점검해 보세요.';

    container.innerHTML = ''
      + '<div class="grid grid-cols-3 gap-3 mb-4">'
      + '<div class="text-center p-3 rounded-xl bg-blue-500/5 border border-blue-500/10">'
      + '<div class="text-xl font-bold text-blue-400">' + (aiDiff > 0 ? '+' : '') + aiDiff + '<i class="fas ' + aiArrow + ' text-sm ml-1"></i></div>'
      + '<div class="text-[10px] text-gray-500 mt-1">AI 점수 변화</div>'
      + '<div class="text-[10px] text-gray-600">' + (first.ai_score || 0) + ' → ' + (last.ai_score || 0) + '</div>'
      + '</div>'
      + '<div class="text-center p-3 rounded-xl bg-accent-500/5 border border-accent-500/10">'
      + '<div class="text-xl font-bold text-accent-400">' + (huDiff > 0 ? '+' : '') + huDiff + '<i class="fas ' + huArrow + ' text-sm ml-1"></i></div>'
      + '<div class="text-[10px] text-gray-500 mt-1">인간 점수 변화</div>'
      + '<div class="text-[10px] text-gray-600">' + (first.human_score || 0) + ' → ' + (last.human_score || 0) + '</div>'
      + '</div>'
      + '<div class="text-center p-3 rounded-xl bg-purple-500/5 border border-purple-500/10">'
      + '<div class="text-xl font-bold text-purple-400">' + (avgDiff > 0 ? '+' : '') + avgDiff + '<i class="fas ' + avgArrow + ' text-sm ml-1"></i></div>'
      + '<div class="text-[10px] text-gray-500 mt-1">종합 변화</div>'
      + '<div class="text-[10px] text-gray-600">' + avgFirst + ' → ' + avgLast + '</div>'
      + '</div>'
      + '</div>'
      + '<div class="p-3 rounded-xl bg-navy-900/40 border border-gray-700/30">'
      + '<div class="flex items-start gap-3">'
      + '<div class="w-8 h-8 rounded-lg bg-accent-500/10 flex items-center justify-center flex-shrink-0 mt-0.5"><i class="fas fa-brain text-accent-400 text-sm"></i></div>'
      + '<div><p class="text-sm text-gray-300 font-medium">성장 인사이트</p>'
      + '<p class="text-xs text-gray-400 mt-1 leading-relaxed">' + insight + '</p>'
      + '<p class="text-[10px] text-gray-600 mt-2">총 ' + (stats.total_writes || 0) + '회 분석 · 첫 분석: ' + formatDate(first.created_at) + '</p>'
      + '</div></div></div>';
  }

  function animateCounter(id, target) {
    var el = $(id);
    if (!el) return;
    var dur = 800;
    var start = performance.now();
    function upd(t) {
      var p = Math.min((t - start) / dur, 1);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(e * target);
      if (p < 1) requestAnimationFrame(upd);
    }
    requestAnimationFrame(upd);
  }

  function updateTrendChart(trend) {
    var el = $('trendChart');
    if (!el) return;
    var ctx = el.getContext('2d');
    if (trendChart) trendChart.destroy();
    trendChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trend.map(function(_, i) { return '#' + (i + 1); }),
        datasets: [
          { label: 'AI 점수', data: trend.map(function(t) { return t.ai_score; }), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', tension: 0.4, fill: true, pointRadius: 5, pointBackgroundColor: '#3b82f6', pointBorderColor: '#0f172a', pointBorderWidth: 2 },
          { label: '인간 점수', data: trend.map(function(t) { return t.human_score; }), borderColor: '#F97316', backgroundColor: 'rgba(249,115,22,0.08)', tension: 0.4, fill: true, pointRadius: 5, pointBackgroundColor: '#F97316', pointBorderColor: '#0f172a', pointBorderWidth: 2 }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#94a3b8', usePointStyle: true, pointStyle: 'circle', padding: 20, font: { family: 'Noto Sans KR' } } } },
        scales: {
          x: { ticks: { color: '#475569' }, grid: { color: 'rgba(148,163,184,0.06)' } },
          y: { min: 0, max: 100, ticks: { color: '#475569', stepSize: 25 }, grid: { color: 'rgba(148,163,184,0.06)' } }
        }
      }
    });
  }

  function updateCategoryChart(catStats) {
    var el = $('categoryChart');
    if (!el) return;
    var ctx = el.getContext('2d');
    if (categoryChart) categoryChart.destroy();
    if (!catStats.length) {
      ctx.font = '500 14px Noto Sans KR';
      ctx.fillStyle = '#475569';
      ctx.textAlign = 'center';
      ctx.fillText('아직 데이터가 없습니다', ctx.canvas.width / 2, ctx.canvas.height / 2);
      return;
    }
    categoryChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: catStats.map(function(c) { return c.name; }),
        datasets: [
          { label: 'AI', data: catStats.map(function(c) { return c.avg_ai; }), backgroundColor: 'rgba(59,130,246,0.6)', borderColor: '#3b82f6', borderWidth: 1, borderRadius: 6, borderSkipped: false },
          { label: '인간', data: catStats.map(function(c) { return c.avg_human; }), backgroundColor: 'rgba(249,115,22,0.6)', borderColor: '#F97316', borderWidth: 1, borderRadius: 6, borderSkipped: false }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#94a3b8', usePointStyle: true, pointStyle: 'circle', padding: 20, font: { family: 'Noto Sans KR' } } } },
        scales: {
          x: { ticks: { color: '#475569' }, grid: { display: false } },
          y: { min: 0, max: 100, ticks: { color: '#475569', stepSize: 25 }, grid: { color: 'rgba(148,163,184,0.06)' } }
        }
      }
    });
  }

  // ==================== API KEYS ====================
  function checkApiKeyOnLogin() {
    fetch(API + '/api/keys?user_id=' + currentUser.id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var keys = data.keys || [];
      var gemini = keys.find(function(k) { return k.provider === 'gemini'; });
      if (gemini && gemini.is_valid) {
        hasValidApiKey = true;
        $('apiKeyBanner').classList.add('hidden');
      } else {
        hasValidApiKey = false;
        $('apiKeyBanner').classList.remove('hidden');
      }
    });
  }

  function loadApiKeyStatus() {
    if (!currentUser) return;
    fetch(API + '/api/keys?user_id=' + currentUser.id)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var keys = data.keys || [];
      var gemini = keys.find(function(k) { return k.provider === 'gemini'; });
      var el = $('geminiStatus');
      if (gemini) {
        if (gemini.is_valid) {
          el.className = 'ml-2 text-[11px] px-2.5 py-0.5 rounded-full bg-green-500/15 text-green-400 font-medium';
          el.textContent = '활성';
          hasValidApiKey = true;
          $('apiKeyBanner').classList.add('hidden');
        } else {
          el.className = 'ml-2 text-[11px] px-2.5 py-0.5 rounded-full bg-red-500/15 text-red-400 font-medium';
          el.textContent = '유효하지 않음';
          hasValidApiKey = false;
        }
      } else {
        el.className = 'ml-2 text-[11px] px-2.5 py-0.5 rounded-full bg-gray-700/50 text-gray-400';
        el.textContent = '미등록';
        hasValidApiKey = false;
      }
    });
  }

  window.toggleKeyInput = function(p) {
    $(p + 'KeyInput').classList.toggle('hidden');
  };

  window.toggleKeyVisibility = function(id) {
    var f = $(id);
    var btn = f.nextElementSibling;
    if (f.type === 'password') {
      f.type = 'text';
      btn.innerHTML = '<i class="fas fa-eye-slash text-sm"></i>';
    } else {
      f.type = 'password';
      btn.innerHTML = '<i class="fas fa-eye text-sm"></i>';
    }
  };

  function showAlert(msg, type) {
    var el = $('apiKeyAlert');
    el.classList.remove('hidden');
    var cls = type === 'success' ? 'bg-green-500/10 border border-green-500/20 text-green-300'
            : type === 'error' ? 'bg-red-500/10 border border-red-500/20 text-red-300'
            : 'bg-blue-500/10 border border-blue-500/20 text-blue-300';
    var icon = type === 'success' ? 'check-circle' : type === 'error' ? 'circle-xmark' : 'circle-info';
    el.className = 'mb-4 px-4 py-3 rounded-xl text-sm flex items-center gap-2 ' + cls;
    el.innerHTML = '<i class="fas fa-' + icon + '"></i>' + msg;
    setTimeout(function() { el.classList.add('hidden'); }, 5000);
  }

  window.saveApiKey = function(p) {
    var f = $(p + 'KeyField');
    var key = f.value.trim();
    if (!key) { showAlert('API 키를 입력해주세요.', 'error'); return; }

    fetch(API + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: currentUser.id, provider: p, api_key: key })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showAlert(data.error, 'error'); return; }
      showAlert('API 키가 저장되었습니다. 검증 버튼을 눌러주세요.', 'success');
      f.value = '';
      loadApiKeyStatus();
    })
    .catch(function(e) { showAlert('저장 오류: ' + e.message, 'error'); });
  };

  window.verifyApiKey = function(p) {
    showAlert('API 키를 검증하고 있습니다...', 'info');
    fetch(API + '/api/keys/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: currentUser.id, provider: p })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.valid) {
        showAlert('API 키가 정상 작동합니다!', 'success');
        showToast('API 키 검증 성공!', 'success');
      } else {
        showAlert('검증 실패: ' + (data.error || '알 수 없는 오류'), 'error');
      }
      loadApiKeyStatus();
    })
    .catch(function(e) { showAlert('검증 오류: ' + e.message, 'error'); });
  };

  window.deleteApiKey = function(p) {
    if (!confirm('이 API 키를 삭제하시겠습니까?')) return;
    fetch(API + '/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: currentUser.id, provider: p })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showAlert(data.error, 'error'); return; }
      showAlert('API 키가 삭제되었습니다.', 'success');
      hasValidApiKey = false;
      loadApiKeyStatus();
      $('apiKeyBanner').classList.remove('hidden');
    })
    .catch(function(e) { showAlert('삭제 오류: ' + e.message, 'error'); });
  };

  // Expose loadHistory for filter change
  window.loadHistory = loadHistory;

})();
