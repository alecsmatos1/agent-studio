import {
  countEvery,
  countdownMs,
  countdownOver,
  shutdownWait,
  watchEvery,
  watchStep,
  type Waiting,
  type WatchState,
} from './shutdown-watch';
import {
  notifyShutdownSoon,
  setShutdownWatch,
  shutDownComputer,
  shutdownWatchStatus,
  windowFocused,
} from './transport';

const nothing: Waiting = { chats: 0, workflows: 0 };

/**
 * Shut down when chats finish in this window (src/lib/shutdown-watch.ts): it looks at the work
 * left every two seconds while on, every second while it counts down, and the app keeps it on
 * through a reload of the window, when this window takes it up again.
 */
export class ShutdownWatch {
  state = $state<WatchState>({ phase: 'off' });
  waiting = $state<Waiting>(nothing);
  /** The time the countdown last looked, which it shows from. */
  now = $state(Date.now());
  // The chats whose replies this computer runs, as the app last said.
  private running: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  // Each turning on or off, which makes an answer to an earlier one stale.
  private turn = 0;
  private stopped = false;
  // When the desktop alert of a countdown last went out.
  private alerted = -Infinity;

  constructor(
    /** The work left, from the chats whose replies run here. */
    private work: (running: readonly string[]) => Waiting,
    /** Saves drafts and chats, and publishes them, before the computer turns off. */
    private prepare: () => Promise<void>,
    /** Says why the computer did not turn off. */
    private failed: (message: string) => void,
  ) {}

  get on() {
    return this.state.phase !== 'off';
  }

  /** Takes up a watch the window left on before it reloaded. */
  async start() {
    const turn = this.turn;
    try {
      const status = await shutdownWatchStatus();
      if (this.stopped || turn !== this.turn || this.on || !status.armed) return;
      this.running = status.running;
      this.state = { phase: 'watching' };
      this.look();
    } catch {
      // The watch stays off.
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  async toggle() {
    if (this.on) await this.cancel();
    else await this.arm();
  }
  private async arm() {
    const turn = ++this.turn;
    const status = await setShutdownWatch(true);
    if (this.stopped || turn !== this.turn) return;
    this.running = status.running;
    this.state = { phase: 'watching' };
    this.look();
  }
  /** Turns the watch off, ending its countdown, or a shutdown the app has not begun. */
  async cancel() {
    if (this.state.phase === 'off' || (this.state.phase === 'shutting' && this.state.asked)) return;
    this.turn++;
    clearTimeout(this.timer);
    this.state = { phase: 'off' };
    this.waiting = nothing;
    await setShutdownWatch(false);
  }
  /** Turns the computer off without waiting for the countdown's end. */
  shutDownNow() {
    if (this.state.phase === 'counting') void this.shutDown();
  }

  private async poll() {
    const turn = this.turn;
    try {
      const status = await shutdownWatchStatus();
      if (turn !== this.turn) return;
      this.running = status.running;
    } catch {
      // It looks again with what it knew.
    }
    this.look();
  }
  /** Reads the work left and moves the watch on. */
  private look() {
    clearTimeout(this.timer);
    const state = this.state;
    if (this.stopped || state.phase === 'off' || state.phase === 'shutting') return;
    let waiting: Waiting;
    try {
      waiting = this.work(this.running);
    } catch {
      // Work it could not read keeps it waiting.
      waiting =
        this.waiting.chats || this.waiting.workflows ? this.waiting : { ...nothing, chats: 1 };
    }
    if (waiting.chats !== this.waiting.chats || waiting.workflows !== this.waiting.workflows)
      this.waiting = waiting;
    const now = Date.now();
    const next = watchStep(state, {
      armed: true,
      busy: waiting.chats + waiting.workflows > 0,
      now,
    });
    if (next !== state) {
      // A reader in another app learns of it there, once a countdown; the window shows it.
      if (
        next.phase === 'counting' &&
        now - this.alerted >= countdownMs &&
        !(windowFocused() && document.visibilityState === 'visible')
      ) {
        this.alerted = now;
        void notifyShutdownSoon().catch(() => {});
      }
      this.state = next;
    }
    this.now = now;
    if (countdownOver(next, now)) {
      void this.shutDown();
      return;
    }
    this.timer = setTimeout(
      () => void this.poll(),
      next.phase === 'counting' ? countEvery : watchEvery,
    );
  }
  private async shutDown() {
    clearTimeout(this.timer);
    const turn = this.turn;
    this.state = { phase: 'shutting', asked: false };
    let outcome: Awaited<ReturnType<typeof shutDownComputer>>;
    try {
      await this.prepare();
      if (turn !== this.turn) return;
      outcome = await shutDownComputer();
    } catch (error) {
      // Cancel was chosen meanwhile.
      if (turn !== this.turn) return;
      this.turn++;
      this.state = { phase: 'off' };
      this.waiting = nothing;
      void setShutdownWatch(false).catch(() => {});
      this.failed(String(error).replace(/^Error: /, ''));
      return;
    }
    if (turn !== this.turn) return;
    // A reply began here meanwhile: the watch waits for it.
    if (outcome === 'running') {
      this.state = { phase: 'watching' };
      this.look();
      return;
    }
    this.state = { phase: 'shutting', asked: true };
    // An app on the computer may still cancel it.
    this.timer = setTimeout(() => {
      if (turn !== this.turn || this.state.phase !== 'shutting') return;
      this.turn++;
      this.state = { phase: 'off' };
      this.waiting = nothing;
      this.failed('This computer did not shut down.');
    }, shutdownWait);
  }
}
