import type { Stage } from './render/Stage';
import type { EngineBridge } from './ipc/EngineBridge';
import type { ControlCommand, PresetDoc } from './ipc/protocol';
import { Sources } from './audio/Sources';
import { BeatTracker } from './time/BeatTracker';
import { KickHistory } from './time/KickHistory';
import { Clock } from './time/Clock';
import { Typesetter } from './text/Typesetter';
import { TextPool } from './text/TextPool';
import { Conductor, type Lane } from './show/Conductor';
import { PresetStore } from './show/PresetStore';
import { PresetBank } from './show/PresetBank';
import { Channels } from './show/Channels';
import { Layer } from './show/Layer';
import { Look } from './show/Look';
import { PALETTES } from './render/palette';
import { FULL, intersect, type Mask } from './show/mask';
import {
  blockedMessage,
  motionOptions,
  needsRetypeset,
  pulseAt,
  pulseOptions,
  textsForBlocks,
  type PulseSpec,
} from './show/wiring';
import type { EffectContext } from './effects/types';

/**
 * The show. DESIGN.md §7.1 — this is the output window's half of the app.
 *
 * Audio in, tempo out, a predicted beat grid driving triggers, triggers driving layers, and a
 * bank of presets cycling on phrase boundaries so it runs unattended.
 *
 * It was a script. Every collaborator was a module-level binding and every function a closure
 * over the module, which meant module *initialisation order* was acting as an implicit
 * constructor — with no way to enforce it and no way to build the thing twice. The clearest
 * symptom was `frameDelta`, declared eight hundred lines from its use site with a comment
 * explaining that reading it any earlier threw, because `applyPreset` ran during module
 * evaluation and built an effect context from it.
 *
 * As a class that cannot happen: construction finishes, and only then does {@link start} run
 * the things that need a finished object.
 */
export class Engine {
  private readonly tracker = new BeatTracker();
  private readonly kicks = new KickHistory();
  private readonly clock = new Clock();
  private readonly conductor = new Conductor();
  private readonly channels = new Channels();
  private readonly store = new PresetStore();

  private readonly typesetter: Typesetter;
  private readonly sources: Sources;
  private readonly texts: TextPool;
  private readonly look: Look;
  private readonly bank: PresetBank;

  /** Phrases the current text has been on screen. Drives held-text behaviour. */
  private textAge = 0;

  /**
   * Seconds since the previous frame, shared with the effect context.
   *
   * Layer decay is derived from elapsed time rather than counted per frame, which is what stops
   * a fade running twice as fast at 60fps as at 30 (§11.5).
   */
  private frameDelta = 0;

  /** The preset an error has already been reported for, so it is said once rather than every phrase. */
  private blockedPreset = '';

  /** The live preset's pulse, read from its layers when the preset is applied. */
  private pulse: PulseSpec | null = null;

  /** Throttles the capture readout, which is rewritten with a peak level as it changes. */
  private lastStatusAt = 0;
  private lastFrameAt = performance.now();

  constructor(
    private readonly stage: Stage,
    private readonly hud: EngineBridge,
  ) {
    this.typesetter = new Typesetter(stage);

    /**
     * Let channel writes reach a seamless conveyor's duplicate elements.
     *
     * Wired once: the lookup reads whatever pairing the typesetter holds now, and that is
     * replaced on every typeset. Without it the copy carries no treatments at all — the
     * original scrolls past lit and its replacement arrives plain, so every wrap looks like the
     * colour dropping out.
     */
    this.channels.setMirror((el) => this.typesetter.twinsOf(el));

    this.sources = new Sources({
      status: (message, isError) => hud.setStatus(message, isError),
      devices: (options, activeId) => hud.setDevices(options, activeId),
      apps: (list) => hud.setApps(list),
      sensitivity: (band, value) => hud.setSensitivity(band, value),
    });

    this.texts = new TextPool(
      {
        status: (message, isError) => hud.setStatus(message, isError),
        list: (active, pending) => hud.setTextList(active, pending),
      },
      (name) => window.olib.texts.read(name),
    );

    this.look = new Look(stage, {
      background: (mode) => hud.setBackground(mode),
      palette: (name) => hud.setPalette(name),
      mask: (mask) => hud.setMask(mask),
      retypeset: () => this.typesetNext(),
    });

    this.bank = new PresetBank(this.store.resolve());
  }

  /**
   * Put something on the stage and start capturing.
   *
   * Separate from the constructor because it needs a finished object: the first `applyPreset`
   * builds an effect context, which reads fields the constructor is still assigning.
   */
  start(): void {
    this.look.apply();

    this.hud.setSource('none');
    this.hud.setBpm(null);
    this.hud.setConfidence(null);
    this.syncStageSize();

    this.publishPresets();
    this.applyPreset();

    void this.sources.start();

    /**
     * Load saved presets, then re-apply.
     *
     * Started after the first `applyPreset` rather than before it, so the stage has something
     * on it while the folder is read. A blank canvas during startup is indistinguishable from
     * a failure to launch.
     */
    void (async () => {
      await this.store.load();
      this.bank.replace(this.store.resolve());
      await this.texts.load(this.store.all);
      this.publishPresets();
      this.applyPreset();

      for (const problem of this.store.problems) this.hud.setStatus(problem, true);
    })();
  }

  /** PCM from per-application capture, straight through to the worklet. */
  acceptPcm(chunk: Float32Array | ArrayBuffer): void {
    this.sources.acceptPcm(chunk);
  }

  /**
   * Anything still unsaved when the window goes away would be lost — the debounce is 600ms and
   * closing the app is faster than that.
   */
  flush(): void {
    void this.store.flush();
  }

  /**
   * Keep the stage the size of the window.
   *
   * The stage is still a fixed, exact resolution — you set it from the Canvas tab rather than
   * by dragging, so layout stays deterministic (§13.1). This only makes the CSS follow when
   * that number changes.
   */
  syncStageSize(): void {
    document.documentElement.style.setProperty('--stage-w', `${window.innerWidth}px`);
    document.documentElement.style.setProperty('--stage-h', `${window.innerHeight}px`);
    this.hud.setCrop(this.stage.cropRect());
  }

  // --- keys --------------------------------------------------------------------------------

  /** Returns whether the key was ours, so the caller knows whether to prevent the default. */
  keydown(event: KeyboardEvent): boolean {
    if (event.key === 'Tab') {
      window.olib.showControl();
      return true;
    }

    if (event.code === 'Space') {
      this.tap();
      return true;
    }

    // Hand the grid back to detection without waiting for a track change.
    if (event.key === 'Escape' && this.clock.isManual) {
      this.clock.releaseManual();
      this.hud.setSource('detected');
      return true;
    }

    return false;
  }

  // --- commands ----------------------------------------------------------------------------

  /**
   * One switch, exhaustively checked.
   *
   * Because `ControlCommand` is a discriminated union, adding a command without handling it
   * here is a compile error rather than a message that silently does nothing.
   */
  handle(command: ControlCommand): void {
    switch (command.type) {
      case 'requestState':
        // A window that just opened needs everything, not the next delta.
        this.publishPresets();
        this.hud.publish();
        break;

      case 'setDevice':
        void this.sources.openDevice(command.id);
        break;

      case 'setAppSource':
        void this.sources.openApp(command.processId, command.title);
        break;

      case 'setSensitivity':
        this.sources.setSensitivity(command.band, command.value);
        break;

      case 'setPalette':
        this.look.setPalette(command.name);
        break;

      case 'setMask':
        this.look.setMask(command.mask);
        break;

      case 'setBackground':
        this.look.setBackground(command.mode);
        break;

      case 'queuePreset':
        this.bank.queue(command.name);
        this.publishPresetState();
        break;

      case 'updatePreset':
        this.applyEdit(command.doc);
        break;

      case 'createPreset': {
        const created = this.store.create(command.from);
        this.bank.replace(this.store.resolve());
        this.bank.setEnabled(created.name, true);
        this.publishPresets();
        // Queued rather than applied: a new preset arriving mid-phrase would read as a fault,
        // and §11.2 says every preset change goes through the same door.
        this.bank.queue(created.name);
        this.publishPresetState();
        break;
      }

      case 'deletePreset':
        if (this.store.remove(command.name)) {
          this.bank.replace(this.store.resolve());
          this.publishPresets();
          this.publishPresetState();
        } else {
          this.hud.setStatus('Cannot delete the last preset', true);
        }
        break;

      case 'renamePreset':
        if (this.store.rename(command.from, command.to) !== null) {
          this.bank.replace(this.store.resolve());
          this.publishPresets();
          this.publishPresetState();
        }
        break;

      case 'restorePresetDefaults':
        void (async () => {
          await this.store.restoreDefaults();
          this.bank.replace(this.store.resolve());
          this.publishPresets();
          this.applyPreset();
          this.hud.setStatus('Built-in presets restored');
        })();
        break;

      case 'setPresetEnabled':
        this.bank.setEnabled(command.name, command.enabled);
        this.publishPresets();
        break;

      case 'applyText':
        this.texts.queue(command.name, command.content);
        break;

      case 'selectText':
        // Selecting only changes what the editor shows; nothing on the stage moves.
        break;

      case 'tapTempo':
        this.tap();
        break;

      case 'releaseManual':
        this.clock.releaseManual();
        this.hud.setSource('detected');
        break;
    }
  }

  // --- the frame ---------------------------------------------------------------------------

  frame(now: number): void {
    // Clamped: after a stall, a huge delta would teleport the scroll rather than continuing it,
    // and would clear a layer in one step rather than fading it.
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.1);
    this.frameDelta = dt;
    this.lastFrameAt = now;

    // Advance the grid before building the context. Anything derived from musical position —
    // beat phase, text age — has to be current when effects read it, and the phrase handler
    // below mutates text age.
    const beat = this.clock.update(now);
    if (beat?.isPhraseStart === true) this.textAge++;

    // Hand the stage the tempo the visual should be moving at, and let it chase. A tap and a
    // detected estimate both arrive here, and both can move a long way in one step (§11.5).
    this.stage.setTargetBar(this.clock.bpm === null ? 2 : (60 / this.clock.bpm) * 4);
    this.stage.tick(dt);

    // Read from the grid rather than from a transient, so it keeps breathing through a passage
    // with nothing hitting in it.
    this.stage.pulse = this.pulse === null ? 0 : pulseAt(this.pulse, this.clock.phase(now));

    const ctx = this.effectContext();

    const analyser = this.sources.analyser;
    if (analyser) {
      const bands = analyser.read(now);
      this.hud.setBands(bands);

      // Onset lanes. These fire on the audio itself rather than the grid, so they carry the
      // detail — syncopation, fills, anything the beat grid cannot know about.
      for (const lane of ['kick', 'snare', 'hat'] as const) {
        if (bands[lane]?.onset === true) this.conductor.fire(lane satisfies Lane, ctx);
      }

      // The envelope the tracker works from. Weighted toward the kick, because that is what
      // carries the beat in this material, but not exclusively — a track with a soft kick
      // still needs something to lock onto.
      const onsetEnergy =
        (bands.kick?.flux ?? 0) * 1 +
        (bands.snare?.flux ?? 0) * 0.6 +
        (bands.hat?.flux ?? 0) * 0.3;

      this.tracker.push(now, onsetEnergy);

      // Kept separately from the tracker's envelope: the tracker wants everything periodic, and
      // this wants only the thing that actually carries the tempo (§9.2.4).
      this.kicks.push(now, bands.kick?.flux ?? 0);
      if (bands.kick?.onset === true) this.kicks.pushOnset(now);

      const estimate = this.tracker.estimate(now);
      if (estimate) {
        this.hud.setEstimate(estimate.bpm);
        this.clock.apply(estimate, {
          authority: this.kicks.authority,
          agreementFor: (periodMs) => this.kicks.agreement(periodMs, now),
        });
        this.publishTempo();
      }

      // Report the raw input peak a few times a second. If this reads -inf while music is
      // playing, nothing is reaching us and the fault is in capture, not analysis.
      if (now - this.lastStatusAt > 250) {
        this.lastStatusAt = now;
        const peak = analyser.peak;
        const db = peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dB` : 'silent';
        this.hud.setStatus(`Capturing · ${this.sources.captureLabel} · peak ${db}`);
      }
    }

    // Grid lanes. Predicted rather than detected (§9.3), so they land on the beat instead of
    // just after it.
    if (beat) {
      this.hud.flashBeat(beat.isDownbeat, this.clock.bpm === null ? 500 : 60_000 / this.clock.bpm);
      this.conductor.fire('beat', ctx);

      if (beat.isDownbeat) {
        this.conductor.fire('bar', ctx);
        this.bank.countBar();
      }

      if (beat.isPhraseStart) {
        this.conductor.fire('phrase', ctx);

        // `held` fires only where the text was *not* replaced this phrase — static text for two
        // phrases needs more happening to it, or the second phrase reads as a stall.
        //
        // It has to be dispatched with a *fresh* context. `ctx` is a snapshot taken at the top
        // of the frame, so its `textAge` still holds the pre-phrase value; re-reading it after
        // the phrase bindings is the only way to see whether the text was replaced.
        if (this.textAge >= 1) this.conductor.fire('held', this.effectContext());

        this.bank.countPhrase();

        // Preset changes land on a phrase boundary — arriving on the 1 of a new 16 is what
        // makes a switch read as intentional rather than as something going wrong. One path
        // whether the change came from the timer or from you clicking it.
        if (this.bank.takeNext()) this.applyPreset();
        this.publishPresetState();

        // Queued text goes live on the same boundary, through the same one-path rule.
        if (this.texts.takePending()) this.typesetNext();
      }
    }

    this.conductor.tick(ctx);

    // Hide lines a moving block has carried half out of frame. No layout reads — it works from
    // the translation the animation has already applied.
    this.typesetter.trimLines();

    this.stage.applyTransform();

    this.hud.countFrame(now);
    this.hud.tick(now);
  }

  // --- the show ----------------------------------------------------------------------------

  /** Built fresh each frame so effects always see current levels. */
  private effectContext(): EffectContext {
    return {
      stage: this.stage,
      typesetter: this.typesetter,
      channels: this.channels,
      energy: this.sources.analyser?.energy ?? 0,
      bass: this.sources.analyser?.bass ?? 0,
      palette: PALETTES[this.look.palette],
      beatPhase: this.clock.phase(performance.now()),
      textAge: this.textAge,
      dt: this.frameDelta,
      // The smoothed tempo, not the raw estimate, so decay agrees with what is on screen.
      barSeconds: this.stage.barSeconds,
      retext: () => this.typesetNext(),
    };
  }

  /** Render the current preset's text selection. */
  private typesetNext(): void {
    const preset = this.bank.current;

    this.typesetter.render(
      textsForBlocks(preset.texts, preset.text.blocks, this.texts.current, this.texts.byName),
      {
        slice: preset.text.slice,
        splitChars: preset.text.splitChars,
        take: preset.text.take,
        length: preset.text.length,
        pick: preset.text.pick,
        position: preset.text.position,
        blocks: preset.text.blocks,
        mask: this.effectiveMask(preset.spawn),
        shapes: preset.blockShapes,
        align: preset.align,
        flow: preset.flow,
        avoidOverlap: preset.avoidOverlap,
        offset: preset.offset,
        wholeLines: preset.wholeLines,
        ...motionOptions(preset.layers),
        size: preset.text.size,
        ...(preset.text.varyBy ? { varyBy: preset.text.varyBy } : {}),
      },
    );

    // The tracked elements no longer exist after a re-render.
    this.channels.forget();
    this.textAge = 0;

    // New blocks mean new animations, and they start at the nominal rate rather than the live
    // one. Cheap: a handful of animations, a few times a minute.
    this.stage.syncMotion();

    // The text's settled look, applied to the elements that were just built. Before any beat
    // has landed, so a static layer is underneath whatever the music adds rather than fighting
    // it for the same channel.
    this.conductor.fire('typeset', this.effectContext());

    this.hud.setClipped(this.typesetter.clipped);

    this.reportBlocked(
      this.typesetter.unplaceable ? preset.name : '',
      this.typesetter.unplaceable ? preset.spawn : FULL,
    );
  }

  /**
   * Switch preset: load its layers, reset the stage, and re-typeset.
   *
   * Everything a preset changes happens in one place, so a preset can never be half-applied —
   * new layers running against text selected by the previous one.
   */
  private applyPreset(): void {
    const preset = this.bank.current;

    // Layers are constructed here rather than stored on the preset, because a layer's id is its
    // ownership token in `Channels` and has to be unique to the *running* stack. Building them
    // per activation also means an edited preset takes effect on the next cycle without any
    // invalidation logic.
    this.conductor.load({
      layers: preset.layers.map((spec, index) => new Layer(index, spec)),
      bindings: preset.bindings,
      ...(preset.ambient ? { ambient: preset.ambient } : {}),
    });

    // The outgoing preset's layers own values on elements that are about to be re-typeset
    // anyway, but a preset change that does not re-typeset would otherwise leave them lit with
    // nothing left to decay them.
    this.channels.clearAll();

    this.publishPresetState();

    // Read once per preset, like motion is. A preset without one leaves the stage still rather
    // than inheriting whatever the last one was doing.
    this.pulse = pulseOptions(preset.layers);
    this.stage.pulse = 0;

    this.typesetNext();
    this.hud.setPreset(preset.name, preset.energy);
  }

  /**
   * Apply an edited document. DESIGN.md §11.4, "two speeds of change".
   *
   * A parameter moves **immediately** — waiting a phrase would make a slider feel broken. A
   * structural change waits for the next phrase, because it is a decision rather than an
   * adjustment. The control window does not have to know which it sent: the difference is
   * visible here, by comparing what actually changed.
   */
  private applyEdit(doc: PresetDoc): void {
    const before = this.store.find(doc.name);
    if (!before || !this.store.update(doc)) return;

    this.bank.replace(this.store.resolve());
    this.publishPresets();

    // Only the live preset has anything running to update. Editing one that is not on stage is
    // already done — it will be built fresh when it goes live.
    if (this.bank.current.name !== doc.name) return;

    if (needsRetypeset(before, doc)) {
      // Placement and text settings are only visible in a re-typeset, so there is nothing to do
      // in place — and doing it now rather than at the phrase is what makes dragging the
      // block-shape numbers legible.
      this.applyPreset();
      return;
    }

    this.retuneLayers(doc);
  }

  /**
   * Push new layer settings into the running stack.
   *
   * Where the shape of the stack is unchanged — same count, same treatments, same order — the
   * `Layer` objects are updated **in place**. That matters more than it looks: a layer's id is
   * its ownership token in `Channels`, so rebuilding the stack orphans every value currently lit
   * and the stage flashes. Dragging a slider would strobe.
   *
   * When the shape *has* changed, rebuilding is unavoidable.
   */
  private retuneLayers(doc: PresetDoc): void {
    const live = this.conductor.layers;
    const sameShape =
      live.length === doc.layers.length &&
      live.every((layer, i) => layer.spec.treatment === doc.layers[i]?.treatment);

    if (!sameShape) {
      this.applyPreset();
      return;
    }

    live.forEach((layer, i) => {
      const spec = doc.layers[i];
      if (spec) layer.update(spec);
    });
  }

  /**
   * Where this preset may anchor (§11.6).
   *
   * The overlap, and nothing else. **The global mask is absolute** — it is the VJ's statement
   * about tonight's frame, and a preset cannot widen it, work around it, or fall back past it.
   * A preset's own mask can only narrow it further.
   */
  private effectiveMask(spawn: Mask): Mask {
    return intersect(this.look.mask, spawn);
  }

  /**
   * Say which mask has left a preset nowhere to go, once rather than every phrase.
   *
   * A sticky error repeating every few bars would bury the capture readout for something that
   * has not changed since it was reported.
   */
  private reportBlocked(name: string, spawn: Mask): void {
    if (name === this.blockedPreset) return;
    this.blockedPreset = name;

    if (name === '') {
      this.hud.clearError();
      return;
    }

    const message = blockedMessage(name, spawn, this.look.mask);
    if (message !== null) this.hud.setStatus(message, true);
  }

  private publishPresets(): void {
    this.hud.setPresets(
      this.bank.all.map((p) => ({
        name: p.name,
        energy: p.energy,
        enabled: this.bank.isEnabled(p.name),
      })),
    );
    this.hud.setPresetDocs(this.store.all);
    void this.texts.load(this.store.all);
  }

  private publishPresetState(): void {
    this.hud.setPresetState(this.bank.current.name, this.bank.pending);
  }

  private publishTempo(): void {
    this.hud.setBpm(this.clock.bpm);
    this.hud.setSource(this.clock.source);
    this.hud.setConfidence(this.clock.confidence);
  }

  private tap(): void {
    this.clock.tap(performance.now());
    this.publishTempo();
  }
}
