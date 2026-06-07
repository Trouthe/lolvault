import { Injectable, NgZone, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export interface LcuAccountIdentifiedEvent {
  vaultId: string;
  puuid: string;
  displayName: string;
}

export interface LcuPhaseChangeEvent {
  vaultId: string;
  phase: string;
}

export interface LcuGameEndedEvent {
  vaultId: string;
  win: boolean | null;
  lpDelta: number | null;
  newTier: string;
  newDivision: string;
  newLP: number;
  newAbsoluteLP: number;
}

export interface LcuLiveState {
  activeVaultId: string | null;
  phase: string;
  gameStartedAt: number | null;
}

@Injectable({ providedIn: 'root' })
export class LcuService {
  private readonly _accountIdentified$ = new Subject<LcuAccountIdentifiedEvent>();
  private readonly _accountUnrecognized$ = new Subject<{ displayName: string }>();
  private readonly _phaseChange$ = new Subject<LcuPhaseChangeEvent>();
  private readonly _gameEnded$ = new Subject<LcuGameEndedEvent>();
  private readonly _disconnected$ = new Subject<void>();

  readonly accountIdentified$: Observable<LcuAccountIdentifiedEvent> =
    this._accountIdentified$.asObservable();
  readonly accountUnrecognized$: Observable<{ displayName: string }> =
    this._accountUnrecognized$.asObservable();
  readonly phaseChange$: Observable<LcuPhaseChangeEvent> = this._phaseChange$.asObservable();
  readonly gameEnded$: Observable<LcuGameEndedEvent> = this._gameEnded$.asObservable();
  readonly disconnected$: Observable<void> = this._disconnected$.asObservable();

  readonly liveState = signal<LcuLiveState>({
    activeVaultId: null,
    phase: 'None',
    gameStartedAt: null,
  });

  constructor(private readonly ngZone: NgZone) {
    window.electronAPI.onLcuAccountIdentified((data) => {
      this.ngZone.run(() => {
        this.liveState.update((s) => ({
          ...s,
          activeVaultId: data.vaultId,
          phase: 'None',
          gameStartedAt: null,
        }));
        this._accountIdentified$.next(data);
      });
    });

    window.electronAPI.onLcuPhaseChange((data) => {
      console.log('[LcuService] phase-change received:', data);
      this.ngZone.run(() => {
        this.liveState.update((s) => ({
          ...s,
          phase: data.phase,
          // Start timer when phase hits GameStart; clear it on None/EndOfGame
          gameStartedAt:
            data.phase === 'GameStart' && s.gameStartedAt === null
              ? Date.now()
              : data.phase === 'None' || data.phase === 'EndOfGame'
                ? null
                : s.gameStartedAt,
        }));
        this._phaseChange$.next(data);
      });
    });

    window.electronAPI.onLcuGameEnded((data) => {
      this.ngZone.run(() => {
        this._gameEnded$.next(data);
      });
    });

    window.electronAPI.onLcuDisconnected(() => {
      this.ngZone.run(() => {
        this.liveState.set({ activeVaultId: null, phase: 'None', gameStartedAt: null });
        this._disconnected$.next();
      });
    });

    window.electronAPI.onLcuAccountUnrecognized((data) => {
      // Silently ignored in UI — still forwarded for completeness
      this.ngZone.run(() => {
        this._accountUnrecognized$.next(data);
      });
    });

    // Pull current state to seed liveState if LCU connected before Angular bootstrapped
    window.electronAPI.getLcuState().then((state) => {
      console.log('[LcuService] pull-on-init state:', state);
      if (state?.activeVaultId) {
        this.ngZone.run(() => {
          this.liveState.set({
            activeVaultId: state.activeVaultId,
            phase: state.phase ?? 'None',
            gameStartedAt: state.phase === 'InProgress' ? Date.now() : null,
          });
        });
      }
    });
  }
}
