import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { NgApexchartsModule } from 'ng-apexcharts';
import { Account } from '../../models/interfaces/Account';
import { MatchCacheRow } from '../../../types/electron';
import { RiotApiService } from '../../services/riot-api.service';

interface RankedEntry {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak: boolean;
}

type MatchRow = MatchCacheRow;

interface AllParticipantsRaw {
  _allParticipants?: ParticipantSummary[];
  [key: string]: unknown;
}

interface ParticipantSummary {
  puuid: string;
  riotIdGameName: string;
  championName: string;
  teamId: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  totalDamageDealtToChampions: number;
  goldEarned: number;
  items: number[];
  win: boolean;
  teamPosition: string;
  visionScore: number;
}

interface LpSnapshot {
  id: number;
  account_id: string;
  timestamp: number;
  tier: string;
  division: string;
  lp: number;
  absolute_lp: number;
}

interface ChampionStat {
  champion: string;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  csPerMin: number;
  damage: number;
}

interface HeatmapCell {
  date: Date;
  netLP: number | null;
  wins: number;
  losses: number;
  isEmpty: boolean;
}

const TIER_BASELINE: Record<string, { kda: number; cspm: number; dmg: number }> = {
  IRON: { kda: 1.8, cspm: 4.5, dmg: 12000 },
  BRONZE: { kda: 2.0, cspm: 5.0, dmg: 14000 },
  SILVER: { kda: 2.2, cspm: 5.5, dmg: 16000 },
  GOLD: { kda: 2.5, cspm: 6.0, dmg: 18000 },
  PLATINUM: { kda: 2.8, cspm: 6.5, dmg: 20000 },
  EMERALD: { kda: 3.0, cspm: 7.0, dmg: 22000 },
  DIAMOND: { kda: 3.3, cspm: 7.5, dmg: 24000 },
  MASTER: { kda: 3.6, cspm: 8.0, dmg: 26000 },
  GRANDMASTER: { kda: 3.9, cspm: 8.5, dmg: 28000 },
  CHALLENGER: { kda: 4.2, cspm: 9.0, dmg: 30000 },
};

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => {
  const h = i % 12 || 12;
  return `${h}${i < 12 ? 'am' : 'pm'}`;
});

@Component({
  selector: 'app-analytics',
  imports: [CommonModule, NgApexchartsModule],
  templateUrl: './analytics.component.html',
  styleUrl: './analytics.component.scss',
})
export class AnalyticsComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private riotApiService = inject(RiotApiService);

  // ── State ────────────────────────────────────────────────────────────────────
  loading = signal(true);
  error = signal<string | null>(null);
  noApiKey = signal(false);

  account = signal<Account | null>(null);
  rankedStats = signal<RankedEntry[]>([]);
  matchHistory = signal<MatchRow[]>([]);
  lpSnapshots = signal<LpSnapshot[]>([]);
  ddragonVersion = signal('15.21.1');

  // ── Interaction state ────────────────────────────────────────────────────────
  expandedMatchId = signal<string | null>(null);
  champSortCol = signal<keyof ChampionStat>('games');
  champSortDesc = signal(true);
  matchLimit = signal(20);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  dayNames = DAY_NAMES;
  hourLabels = HOUR_LABELS;

  // ── Section A ────────────────────────────────────────────────────────────────
  soloQ = computed(() => this.rankedStats().find((e) => e.queueType === 'RANKED_SOLO_5x5') ?? null);
  flexQ = computed(() => this.rankedStats().find((e) => e.queueType === 'RANKED_FLEX_SR') ?? null);

  winRate = computed(() => {
    const sq = this.soloQ();
    if (!sq) return '0.0';
    const total = sq.wins + sq.losses;
    return total === 0 ? '0.0' : ((sq.wins / total) * 100).toFixed(1);
  });

  winStreak = computed(() => {
    const matches = [...this.matchHistory()].sort((a, b) => b.timestamp - a.timestamp);
    let streak = 0;
    for (const m of matches) {
      if (m.win === 1) streak++;
      else break;
    }
    return streak;
  });

  lossStreak = computed(() => {
    const matches = [...this.matchHistory()].sort((a, b) => b.timestamp - a.timestamp);
    let streak = 0;
    for (const m of matches) {
      if (m.win === 0) streak++;
      else break;
    }
    return streak;
  });

  rankEmblemUrl = computed(() => {
    const sq = this.soloQ();
    if (!sq) return null;
    const tier = sq.tier.charAt(0).toUpperCase() + sq.tier.slice(1).toLowerCase();
    return `assets/emblems/${tier}.png`;
  });

  profileIconUrl = computed(() =>
    this.riotApiService.getProfileIconUrl(this.account()?.profileIconId)
  );

  // ── Section B — LP Climb chart ───────────────────────────────────────────────
  climbSeries = computed(() => [
    {
      name: 'LP',
      data: this.lpSnapshots().map((s) => ({ x: s.timestamp, y: s.absolute_lp })),
    },
  ]);

  climbChartOptions = computed(() => ({
    chart: {
      type: 'area' as const,
      height: 200,
      background: 'transparent',
      toolbar: { show: false },
      animations: { enabled: false },
      sparkline: { enabled: false },
    },
    stroke: { curve: 'smooth' as const, width: 2 },
    fill: {
      type: 'gradient' as const,
      gradient: { shadeIntensity: 1, opacityFrom: 0.3, opacityTo: 0.05 },
    },
    colors: ['#C89B3C'],
    xaxis: {
      type: 'datetime' as const,
      labels: { style: { colors: '#888', fontSize: '10px' } },
      axisBorder: { show: false },
    },
    yaxis: {
      labels: {
        style: { colors: '#888', fontSize: '10px' },
        formatter: (val: number) => this.absLpToLabel(Math.round(val)),
      },
    },
    tooltip: {
      theme: 'dark',
      x: { format: 'MMM dd' },
      y: { formatter: (val: number) => this.absLpToLabel(Math.round(val)) },
    },
    grid: { borderColor: '#2a2a2a', strokeDashArray: 3 },
    theme: { mode: 'dark' as const },
    annotations: {
      yaxis: [400, 800, 1200, 1600, 2000, 2400, 2800].map((lp) => ({
        y: lp,
        borderColor: '#444',
        strokeDashArray: 4,
        label: {
          borderColor: 'transparent',
          offsetX: -8,
          style: { color: '#555', background: 'transparent', fontSize: '9px' },
          text: this.absLpToLabel(lp).split(' ')[0],
        },
      })),
    },
  }));

  hasLpData = computed(() => this.lpSnapshots().length >= 2);

  // ── Section C — Heatmap ──────────────────────────────────────────────────────
  heatmapGrid = computed<HeatmapCell[][]>(() => {
    const snaps = this.lpSnapshots();
    const matches = this.matchHistory();

    // Build day → { firstAbsLP, lastAbsLP, wins, losses }
    const dayMap = new Map<
      string,
      {
        firstTs: number;
        lastTs: number;
        firstLP: number;
        lastLP: number;
        wins: number;
        losses: number;
      }
    >();

    for (const s of snaps) {
      const d = new Date(s.timestamp);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const existing = dayMap.get(key);
      if (!existing) {
        dayMap.set(key, {
          firstTs: s.timestamp,
          lastTs: s.timestamp,
          firstLP: s.absolute_lp,
          lastLP: s.absolute_lp,
          wins: 0,
          losses: 0,
        });
      } else {
        if (s.timestamp < existing.firstTs) {
          existing.firstTs = s.timestamp;
          existing.firstLP = s.absolute_lp;
        }
        if (s.timestamp > existing.lastTs) {
          existing.lastTs = s.timestamp;
          existing.lastLP = s.absolute_lp;
        }
      }
    }

    for (const m of matches) {
      const d = new Date(m.timestamp);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const entry = dayMap.get(key);
      if (entry) {
        if (m.win === 1) entry.wins++;
        else if (m.win === 0) entry.losses++;
      }
    }

    // Build 12-week grid (col=week, row=day-of-week Mon=0)
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const dow = (today.getDay() + 6) % 7; // 0=Mon
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - dow);
    weekStart.setHours(0, 0, 0, 0);

    const grid: HeatmapCell[][] = [];
    for (let col = 0; col < 12; col++) {
      grid[col] = [];
      for (let row = 0; row < 7; row++) {
        const cellDate = new Date(weekStart);
        cellDate.setDate(weekStart.getDate() + row - (11 - col) * 7);
        const key = `${cellDate.getFullYear()}-${cellDate.getMonth()}-${cellDate.getDate()}`;
        const entry = dayMap.get(key);
        const isFuture = cellDate > today;
        grid[col].push({
          date: cellDate,
          netLP: entry ? entry.lastLP - entry.firstLP : null,
          wins: entry?.wins ?? 0,
          losses: entry?.losses ?? 0,
          isEmpty: !entry || isFuture,
        });
      }
    }
    return grid;
  });

  // ── Section D — Match History ─────────────────────────────────────────────────
  displayedMatches = computed(() => this.matchHistory().slice(0, this.matchLimit()));

  // ── Section E — Champion Stats ───────────────────────────────────────────────
  champStats = computed<ChampionStat[]>(() => {
    const map = new Map<string, ChampionStat>();
    for (const m of this.matchHistory()) {
      const champ = m.champion || 'Unknown';
      const existing = map.get(champ) ?? {
        champion: champ,
        games: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        cs: 0,
        csPerMin: 0,
        damage: 0,
      };
      existing.games++;
      if (m.win === 1) existing.wins++;
      existing.kills += m.kills ?? 0;
      existing.deaths += m.deaths ?? 0;
      existing.assists += m.assists ?? 0;
      existing.cs += m.cs ?? 0;
      existing.csPerMin += m.cs_per_min ?? 0;
      existing.damage += m.damage_dealt ?? 0;
      map.set(champ, existing);
    }
    return Array.from(map.values()).map((s) => ({
      ...s,
      csPerMin: s.games > 0 ? +(s.csPerMin / s.games).toFixed(1) : 0,
    }));
  });

  sortedChampStats = computed(() => {
    const col = this.champSortCol();
    const desc = this.champSortDesc();
    return [...this.champStats()].sort((a, b) => {
      const av = col === 'csPerMin' ? a.csPerMin : (a[col] as number);
      const bv = col === 'csPerMin' ? b.csPerMin : (b[col] as number);
      return desc ? bv - av : av - bv;
    });
  });

  // ── Section F — Performance ───────────────────────────────────────────────────
  avgStats = computed(() => {
    const ms = this.matchHistory();
    if (!ms.length) return null;
    const n = ms.length;
    const kills = ms.reduce((s, m) => s + (m.kills ?? 0), 0) / n;
    const deaths = ms.reduce((s, m) => s + (m.deaths ?? 0), 0) / n;
    const assists = ms.reduce((s, m) => s + (m.assists ?? 0), 0) / n;
    const kda = deaths > 0 ? (kills + assists) / deaths : kills + assists;
    const cspm = ms.reduce((s, m) => s + (m.cs_per_min ?? 0), 0) / n;
    const dmg = ms.reduce((s, m) => s + (m.damage_dealt ?? 0), 0) / n;
    const visionScore = ms.reduce((s, m) => s + (m.vision_score ?? 0), 0) / n;
    const wr = (ms.filter((m) => m.win === 1).length / n) * 100;
    return { kills, deaths, assists, kda, cspm, dmg, visionScore, wr };
  });

  tierBaseline = computed(() => {
    const sq = this.soloQ();
    const tier = (sq?.tier || 'GOLD').toUpperCase();
    return TIER_BASELINE[tier] ?? TIER_BASELINE['GOLD'];
  });

  // ── Section G — Behavioral ────────────────────────────────────────────────────
  wrByDay = computed(() => {
    const buckets = Array.from({ length: 7 }, () => ({ wins: 0, total: 0 }));
    for (const m of this.matchHistory()) {
      const dow = (new Date(m.timestamp).getDay() + 6) % 7;
      buckets[dow].total++;
      if (m.win === 1) buckets[dow].wins++;
    }
    return buckets.map((b, i) => ({
      label: DAY_NAMES[i],
      wr: b.total > 0 ? +((b.wins / b.total) * 100).toFixed(1) : null,
      games: b.total,
    }));
  });

  wrByHour = computed(() => {
    const buckets = Array.from({ length: 24 }, () => ({ wins: 0, total: 0 }));
    for (const m of this.matchHistory()) {
      const hour = new Date(m.timestamp).getHours();
      buckets[hour].total++;
      if (m.win === 1) buckets[hour].wins++;
    }
    return buckets.map((b, i) => ({
      label: HOUR_LABELS[i],
      wr: b.total > 0 ? +((b.wins / b.total) * 100).toFixed(1) : null,
      games: b.total,
    }));
  });

  topChampsLast30 = computed(() => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    // Use all matches but filter by timestamp
    const map = new Map<string, { wins: number; games: number }>();
    for (const m of this.matchHistory()) {
      if (m.timestamp < cutoff) continue;
      const c = m.champion || 'Unknown';
      const e = map.get(c) ?? { wins: 0, games: 0 };
      e.games++;
      if (m.win === 1) e.wins++;
      map.set(c, e);
    }
    return [...map.entries()]
      .sort((a, b) => b[1].games - a[1].games)
      .slice(0, 3)
      .map(([champ, stat]) => ({
        champ,
        ...stat,
        wr: +((stat.wins / stat.games) * 100).toFixed(1),
      }));
  });

  tiltDetector = computed(() => {
    const streak = this.lossStreak();
    if (streak >= 5)
      return { level: 'critical' as const, message: `${streak}-game loss streak — take a break!` };
    if (streak >= 3)
      return {
        level: 'warning' as const,
        message: `${streak} losses in a row — consider a pause.`,
      };
    return { level: 'ok' as const, message: 'No tilt detected.' };
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  async ngOnInit() {
    const vaultId = this.route.snapshot.paramMap.get('vaultId') ?? '';

    this.loading.set(true);
    this.error.set(null);

    try {
      const accounts: Account[] = await window.electronAPI.loadAccounts();
      const account = accounts.find((a) => (a.syncId || String(a.id)) === vaultId) ?? null;
      if (!account) throw new Error('Account not found');
      this.account.set(account);

      const keyResult = await window.electronAPI.getApiKey();
      if (!keyResult?.value) {
        this.noApiKey.set(true);
        this.loading.set(false);
        return;
      }

      const [gameName, tagLine] = (account.name || '').split('#');
      const platform = this.riotApiService.serverToPlatform(account.server || 'EUW');

      let puuid = account.puuid as string | undefined;
      if (!puuid && gameName && tagLine) {
        const s = await window.electronAPI.riotGetSummonerByRiotId({ gameName, tagLine, platform });
        puuid = s && 'puuid' in s ? s.puuid : undefined;
      }

      if (!puuid) throw new Error('Could not resolve PUUID for this account');

      const [ranked, lpResult, version] = await Promise.all([
        window.electronAPI.riotGetRankedByPuuid({ puuid, platform }),
        window.electronAPI.getLpSnapshots(vaultId),
        window.electronAPI.riotGetDDragonVersion(),
      ]);

      if (ranked && !Array.isArray(ranked) && (ranked as { error?: string }).error) {
        throw new Error((ranked as { error: string }).error);
      }

      this.rankedStats.set(Array.isArray(ranked) ? ranked : []);
      this.lpSnapshots.set((lpResult as { snapshots?: LpSnapshot[] })?.snapshots ?? []);
      this.ddragonVersion.set(version ?? '15.21.1');

      // Fetch match history (triggers cache refresh + returns rows)
      const matches = await window.electronAPI.riotGetMatchHistory({
        accountId: vaultId,
        puuid,
        platform,
        count: 20,
      });
      this.matchHistory.set(Array.isArray(matches) ? matches : []);
    } catch (err: unknown) {
      this.error.set(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      this.loading.set(false);
    }
  }

  // ── Public methods ────────────────────────────────────────────────────────────
  goBack() {
    this.router.navigate(['/dashboard']);
  }

  toggleMatch(id: string) {
    this.expandedMatchId.update((v) => (v === id ? null : id));
  }

  setSortCol(col: keyof ChampionStat) {
    if (this.champSortCol() === col) {
      this.champSortDesc.update((v) => !v);
    } else {
      this.champSortCol.set(col);
      this.champSortDesc.set(true);
    }
  }

  loadMoreMatches() {
    this.matchLimit.update((v) => v + 20);
  }

  // ── Template helpers ──────────────────────────────────────────────────────────
  absLpToLabel(lp: number): string {
    const tiers = [
      { name: 'CHALLENGER', min: 2800 },
      { name: 'MASTER', min: 2800 },
      { name: 'DIAMOND', min: 2400 },
      { name: 'EMERALD', min: 2000 },
      { name: 'PLATINUM', min: 1600 },
      { name: 'GOLD', min: 1200 },
      { name: 'SILVER', min: 800 },
      { name: 'BRONZE', min: 400 },
      { name: 'IRON', min: 0 },
    ];
    for (const t of tiers) {
      if (lp >= t.min) {
        const withinTier = lp - t.min;
        if (t.name === 'MASTER' || t.name === 'GRANDMASTER' || t.name === 'CHALLENGER') {
          return `${t.name} ${lp - 2800}LP`;
        }
        const divIndex = Math.floor(withinTier / 100);
        const divNames = ['IV', 'III', 'II', 'I'];
        const div = divNames[Math.min(divIndex, 3)];
        const innerLP = withinTier % 100;
        return `${t.name} ${div} ${innerLP}LP`;
      }
    }
    return `${lp}LP`;
  }

  formatDuration(seconds: number | null): string {
    if (!seconds) return '-';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  getKda(k: number | null, d: number | null, a: number | null): string {
    const kills = k ?? 0;
    const deaths = d ?? 0;
    const assists = a ?? 0;
    if (deaths === 0) return `${(kills + assists).toFixed(1)}:0 KDA`;
    return ((kills + assists) / deaths).toFixed(2);
  }

  parseItems(str: string | null): number[] {
    if (!str) return [];
    try {
      return JSON.parse(str).filter((id: number) => id > 0);
    } catch {
      return [];
    }
  }

  getAllParticipants(row: MatchRow): ParticipantSummary[] {
    return (row.raw_json as AllParticipantsRaw)?._allParticipants ?? [];
  }

  getTeam(row: MatchRow, win: boolean): ParticipantSummary[] {
    const all = this.getAllParticipants(row);
    if (!all.length) return [];
    const myPuuid = row.puuid;
    const me = all.find((p) => p.puuid === myPuuid);
    if (!me) return all.filter((p) => p.win === win);
    return all.filter((p) => (p.teamId === me.teamId ? win === me.win : win !== me.win));
  }

  getItemUrl(itemId: number): string {
    return this.riotApiService.getItemIconUrl(itemId);
  }

  getChampIconUrl(champion: string | null): string {
    return this.riotApiService.getChampionIconUrl(champion ?? '');
  }

  getCellColor(netLP: number | null, isEmpty: boolean): string {
    if (isEmpty || netLP === null) return 'transparent';
    if (netLP === 0) return '#2a2a2a';
    if (netLP > 0) {
      const intensity = Math.min(netLP / 100, 1);
      const g = Math.round(80 + intensity * 120);
      return `rgba(0,${g},60,0.85)`;
    }
    const intensity = Math.min(Math.abs(netLP) / 100, 1);
    const r = Math.round(80 + intensity * 120);
    return `rgba(${r},30,30,0.85)`;
  }

  getCellTooltip(cell: HeatmapCell): string {
    if (cell.isEmpty) return '';
    const dateStr = cell.date.toLocaleDateString('en-GB', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const lp =
      cell.netLP !== null
        ? (cell.netLP > 0 ? `+${cell.netLP}` : `${cell.netLP}`) + 'LP'
        : 'No LP data';
    return `${dateStr} — ${lp} (${cell.wins}W/${cell.losses}L)`;
  }

  getWrBarColor(wr: number | null): string {
    if (wr === null) return '#333';
    if (wr >= 55) return '#27ae60';
    if (wr >= 50) return '#C89B3C';
    return '#e74c3c';
  }

  getAvgComparison(actual: number, baseline: number): 'above' | 'at' | 'below' {
    const ratio = actual / baseline;
    if (ratio >= 1.05) return 'above';
    if (ratio >= 0.95) return 'at';
    return 'below';
  }

  getTierLabel(sq: RankedEntry | null): string {
    if (!sq) return 'UNRANKED';
    return `${sq.tier} ${sq.rank} — ${sq.leaguePoints} LP`;
  }
}
