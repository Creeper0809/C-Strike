/**
 * C-STRIKE 2026 Real-time Scoreboard
 */

// ══════════════════════════ State ══════════════════════════
let state = null;
let prevRanks = {};
let prevTotals = {};
let trendChart = null;
let ws = null;
let activeMatrixFilter = "all";
let frozenSnapshot = null; // 프리즈 시점의 rankings 스냅샷

// ══════════════════════════ WebSocket ══════════════════════════
function connectWebSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onmessage = (event) => {
        const newState = JSON.parse(event.data);

        // 프리즈 시작 시점에 스냅샷 저장
        if (newState.is_frozen && !frozenSnapshot) {
            frozenSnapshot = JSON.parse(JSON.stringify(newState.rankings));
        }
        if (!newState.is_frozen) {
            frozenSnapshot = null;
        }

        state = newState;
        render();
    };

    ws.onclose = () => {
        console.log("WebSocket closed, reconnecting in 3s...");
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => ws.close();
}

// ══════════════════════════ Clock ══════════════════════════
function updateClock() {
    const el = document.getElementById("clock");
    if (el) {
        el.textContent = new Date().toLocaleTimeString("ko-KR", {
            hour: "2-digit", minute: "2-digit", second: "2-digit"
        });
    }
}
setInterval(updateClock, 1000);
updateClock();

// ══════════════════════════ Tabs ══════════════════════════
function initTabs() {
    document.querySelectorAll(".nav-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById(tab.dataset.tab).classList.add("active");
        });
    });
}

// ══════════════════════════ Fullscreen ══════════════════════════
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
        document.body.classList.add("fullscreen-mode");
    } else {
        document.exitFullscreen();
        document.body.classList.remove("fullscreen-mode");
    }
}

// ══════════════════════════ Render ══════════════════════════
function render() {
    if (!state) return;
    renderHeader();
    renderVulnpacks();
    renderRankings();
    renderTrendChart();
    renderAttackMatrix();
    renderDefenseStats();
    renderBonusSummary();
}

// ── Header ──
function renderHeader() {
    const title = state.competition_name || "C-STRIKE";
    const titleEl = document.querySelector(".header-title");
    if (titleEl) {
        titleEl.textContent = title;
    }
    document.title = `${title} 스코어보드`;
    document.getElementById("roundBadge").textContent = `라운드 ${state.round}`;

    const frozenEl = document.getElementById("frozenBadge");
    if (state.is_frozen) {
        frozenEl.classList.add("active");
        document.getElementById("liveIndicator").style.display = "none";
    } else {
        frozenEl.classList.remove("active");
        document.getElementById("liveIndicator").style.display = "flex";
    }
}

// ── Vulnpack Timer ──
function renderVulnpacks() {
    const bar = document.getElementById("vulnpackBar");
    if (!state.vulnpack_schedule) return;

    bar.innerHTML = state.vulnpack_schedule.map((vp, i) => {
        const isReleased = vp.released;
        const isNext = !isReleased && (i === 0 || state.vulnpack_schedule[i - 1].released);
        const dotClass = isReleased ? "released" : isNext ? "next" : "";
        const labelClass = isReleased ? "released" : isNext ? "next" : "";

        let extra = "";
        if (isNext) {
            extra = `<span class="vulnpack-countdown">다음 공개</span>`;
        }
        if (isReleased && vp.services.length > 0) {
            extra = `<span class="vulnpack-services">${vp.services.join(", ")}</span>`;
        }

        return `
            <div class="vulnpack-item">
                <div class="vulnpack-dot ${dotClass}"></div>
                <span class="vulnpack-label ${labelClass}">취약점팩 ${vp.pack_number}</span>
                ${extra}
            </div>
        `;
    }).join("");
}

// ── Rankings ──
function renderRankings() {
    const rankings = state.is_frozen && frozenSnapshot ? frozenSnapshot : state.rankings;
    const maxTotal = Math.max(...rankings.map(r => r.total), 1);
    const tbody = document.getElementById("scoreboardBody");

    tbody.innerHTML = rankings.map((r, i) => {
        const rank = i + 1;
        const t = r.team;
        const pct = (r.total / maxTotal * 100).toFixed(0);
        const rankClass = rank <= 3 ? `rank-${rank}` : "";

        let rowClass = "";
        if (prevRanks[t.id] !== undefined) {
            if (prevRanks[t.id] > rank) rowClass = "row-up";
            else if (prevRanks[t.id] < rank) rowClass = "row-down";
        }
        prevRanks[t.id] = rank;

        const prevTotal = prevTotals[t.id] || 0;
        prevTotals[t.id] = r.total;
        const changeHtml = "";

        return `
            <tr class="${rowClass}" data-rank="${rank}">
                <td class="rank ${rankClass}">${rank}</td>
                <td class="team-name">${t.name}</td>
                <td class="score-cell score-atk">${r.scores.attack.toLocaleString()}</td>
                <td class="score-cell score-def">${r.scores.defense.toLocaleString()}</td>
                <td class="score-cell score-bonus">${r.scores.bonus.toLocaleString()}</td>
                <td>
                    <span class="score-cell score-total">${r.total.toLocaleString()}</span>
                    ${changeHtml}
                    <div class="score-bar"><div class="score-bar-fill" style="width:${pct}%"></div></div>
                </td>
            </tr>
        `;
    }).join("");

    // frozen overlay
    const overlay = document.getElementById("frozenOverlay");
    if (state.is_frozen) overlay.classList.add("active");
    else overlay.classList.remove("active");
}

// ── Trend Chart ──
function renderTrendChart() {
    const ctx = document.getElementById("trendCanvas");
    if (!ctx) return;

    const teams = state.teams;
    const history = state.score_history;

    // 라운드 라벨
    const sampleHistory = history[teams[0].id];
    if (!sampleHistory || sampleHistory.length === 0) return;
    const labels = sampleHistory.map(h => `R${h.round}`);

    const datasets = teams.map(t => ({
        label: t.name,
        data: history[t.id].map(h => h.total),
        borderColor: t.color,
        backgroundColor: t.color + "20",
        borderWidth: 2,
        tension: 0.3,
        pointRadius: sampleHistory.length > 30 ? 0 : 3,
        pointBackgroundColor: t.color,
        fill: false,
    }));

    if (trendChart) {
        trendChart.data.labels = labels;
        trendChart.data.datasets = datasets;
        trendChart.update("none");
    } else {
        trendChart = new Chart(ctx, {
            type: "line",
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: "#90a4ae", font: { size: 16 } } }
                },
                scales: {
                    x: { ticks: { color: "#607d8b", font: { size: 13 } }, grid: { color: "rgba(255,255,255,0.05)" } },
                    y: { ticks: { color: "#607d8b", font: { size: 13 } }, grid: { color: "rgba(255,255,255,0.05)" }, beginAtZero: true }
                }
            }
        });
    }
}

// ── Attack Matrix ──
function renderAttackMatrix() {
    const container = document.getElementById("matrixContainer");
    if (!container) return;

    // 카테고리 필터
    const categories = [...new Set(state.all_services.map(s => s.category))];
    const filterBar = document.getElementById("matrixFilters");
    filterBar.innerHTML = `<button class="filter-btn ${activeMatrixFilter === 'all' ? 'active' : ''}" data-filter="all">전체</button>` +
        categories.map(c => `<button class="filter-btn ${activeMatrixFilter === c ? 'active' : ''}" data-filter="${c}">${c}</button>`).join("");

    filterBar.querySelectorAll(".filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            activeMatrixFilter = btn.dataset.filter;
            renderAttackMatrix();
        });
    });

    // 필터된 서비스
    const filteredServices = activeMatrixFilter === "all"
        ? state.services
        : state.services.filter(s => s.category === activeMatrixFilter);

    if (filteredServices.length === 0) {
        container.innerHTML = `<p style="color:var(--text-dim);text-align:center;padding:20px;">이 카테고리에 공개된 서비스가 없습니다</p>`;
        return;
    }

    // 공격 합산 (필터된 서비스들에 대해)
    const teams = state.teams;
    const aggregated = {};
    teams.forEach(atk => {
        aggregated[atk.id] = {};
        teams.forEach(vic => {
            if (atk.id === vic.id) return;
            let total = 0;
            filteredServices.forEach(svc => {
                const m = state.attack_matrix[svc.id];
                if (m && m[atk.id] && m[atk.id][vic.id] !== undefined) {
                    total += m[atk.id][vic.id];
                }
            });
            aggregated[atk.id][vic.id] = total;
        });
    });

    // 최대값 (히트맵 스케일링)
    let maxVal = 0;
    Object.values(aggregated).forEach(row => {
        Object.values(row).forEach(v => { if (v > maxVal) maxVal = v; });
    });

    function heatClass(val) {
        if (maxVal === 0) return "heat-0";
        const ratio = val / maxVal;
        if (ratio === 0) return "heat-0";
        if (ratio < 0.25) return "heat-1";
        if (ratio < 0.5) return "heat-2";
        if (ratio < 0.75) return "heat-3";
        return "heat-4";
    }

    const headerRow = `<tr><th class="corner-label">공격 \\ 방어</th>${teams.map(t => `<th>${t.name.replace('Team ', '')}</th>`).join("")}</tr>`;

    const bodyRows = teams.map(atk => {
        const cells = teams.map(vic => {
            if (atk.id === vic.id) return `<td class="matrix-cell self">-</td>`;
            const val = aggregated[atk.id][vic.id] || 0;
            return `<td class="matrix-cell ${heatClass(val)}" title="${atk.name} → ${vic.name}: ${val}">${val}</td>`;
        }).join("");
        return `<tr><th>${atk.name.replace('Team ', '')}</th>${cells}</tr>`;
    }).join("");

    container.innerHTML = `<table class="matrix-table"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}

// ── Defense Stats ──
function renderDefenseStats() {
    const grid = document.getElementById("defenseGrid");
    if (!grid) return;

    const teams = state.teams;
    const filteredServices = activeMatrixFilter === "all"
        ? state.services
        : state.services.filter(s => s.category === activeMatrixFilter);

    // 팀별 방어율 합산
    const defenseRates = teams.map(t => {
        let totalBlocked = 0;
        let totalAttempted = 0;
        filteredServices.forEach(svc => {
            const rec = state.defense_record[svc.id];
            if (rec && rec[t.id]) {
                totalBlocked += rec[t.id].blocked;
                totalAttempted += rec[t.id].total_attempted;
            }
        });
        const rate = totalAttempted > 0 ? (totalBlocked / totalAttempted * 100) : 0;
        return { team: t, blocked: totalBlocked, attempted: totalAttempted, rate };
    }).sort((a, b) => b.rate - a.rate);

    grid.innerHTML = defenseRates.map(d => `
        <div class="defense-card">
            <div class="defense-card-header">
                <span class="defense-team-name">${d.team.name}</span>
                <span class="defense-rate">${d.rate.toFixed(1)}%</span>
            </div>
            <div class="defense-bar"><div class="defense-bar-fill" style="width:${d.rate}%"></div></div>
            <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;font-weight:700;">
                ${d.blocked} 차단 / ${d.attempted} 시도
            </div>
        </div>
    `).join("");
}

// ── Bonus Zone (통합) ──
function renderBonusSummary() {
    const container = document.getElementById("bonusSummary");
    if (!container || !state.bonus) return;

    const problems = state.bonus.problems;

    // 문제 카드
    container.innerHTML = problems.map(p => {
        const pct = ((p.current_score - p.min_score) / (p.max_score - p.min_score) * 100).toFixed(0);
        const fbTeam = p.first_blood ? state.teams.find(t => t.id === p.first_blood) : null;
        const fbHtml = fbTeam
            ? `<div class="bonus-fb"><span class="bonus-fb-icon">&#9876;</span> 퍼스트 블러드: ${fbTeam.name}</div>`
            : "";

        const solverHtml = p.solvers.length > 0
            ? `<div class="bonus-solvers">
                <div class="bonus-solvers-title">풀이 현황</div>
                ${p.solvers.map((s, i) => {
                    const team = state.teams.find(t => t.id === s.team_id);
                    return `<div class="bonus-solver-row">
                        <span>${i + 1}. ${team ? team.name : s.team_id}</span>
                        <span style="color:var(--text-dim);font-size:0.75rem;">라운드 ${s.solved_at}</span>
                        <span style="color:var(--bonus-color);font-weight:600;">+${s.score}</span>
                    </div>`;
                }).join("")}
               </div>`
            : `<div style="color:var(--text-muted);font-size:0.82rem;text-align:center;padding:8px;">아직 풀이 없음</div>`;

        return `
            <div class="bonus-problem-card ${p.solve_count > 0 ? 'has-solves' : ''}">
                <div class="bonus-problem-header">
                    <span class="bonus-problem-name">${p.name}</span>
                    <span class="bonus-problem-cat">${p.category}</span>
                </div>
                <div class="bonus-problem-score">
                    <span class="bonus-problem-pts">${p.current_score}</span>
                    <span class="bonus-problem-max">/ ${p.max_score} 점</span>
                </div>
                <div class="bonus-decay-bar"><div class="bonus-decay-fill" style="width:${pct}%"></div></div>
                <div class="bonus-problem-solvecount">${p.solve_count}팀 풀이 완료</div>
                ${fbHtml}
                ${solverHtml}
            </div>
        `;
    }).join("");

    // 리더보드
    const lbBody = document.getElementById("bonusLeaderboard");
    if (!lbBody) return;

    const teamBonuses = state.teams.map(t => {
        let totalScore = 0;
        let solveCount = 0;
        state.bonus.problems.forEach(p => {
            p.solvers.forEach(s => {
                if (s.team_id === t.id) { totalScore += s.score; solveCount++; }
            });
        });
        return { team: t, totalScore, solveCount };
    }).sort((a, b) => b.totalScore - a.totalScore);

    lbBody.innerHTML = teamBonuses.map((tb, i) => `
        <tr>
            <td style="font-weight:700;${i === 0 ? 'color:#ffd700' : ''}">${i + 1}</td>
            <td style="font-weight:600;">${tb.team.name}</td>
            <td>${tb.solveCount} / ${state.bonus.problems.length}</td>
            <td style="font-weight:700;color:var(--bonus-color)">${tb.totalScore.toLocaleString()}</td>
        </tr>
    `).join("");
}

// ══════════════════════════ Theme Toggle ══════════════════════════
function toggleTheme() {
    const html = document.documentElement;
    const btn = document.getElementById("btnTheme");
    if (html.getAttribute("data-theme") === "dark") {
        html.setAttribute("data-theme", "light");
        btn.innerHTML = "&#9788; 다크";
    } else {
        html.setAttribute("data-theme", "dark");
        btn.innerHTML = "&#9789; 라이트";
    }
    // 차트 재생성 (테마 변경 시 색상 반영)
    if (trendChart) {
        trendChart.destroy();
        trendChart = null;
        renderTrendChart();
    }
}

// ══════════════════════════ Init ══════════════════════════
document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    connectWebSocket();

    document.getElementById("btnFullscreen").addEventListener("click", toggleFullscreen);
    const themeBtn = document.getElementById("btnTheme");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
});
