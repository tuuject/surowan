const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** DOM-only scrollspy; form values and validation stay with the caller. */
export class SectionOutline {
  private root: HTMLElement | null = null;
  private sections: HTMLElement[] = [];
  private listeners = new Set<() => void>();
  private active: string | null = null;
  private locked: string | null = null;
  private jump: { scroller: Element; target: number; frame: number } | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getActiveId = () => this.active;

  attach = (root: HTMLDivElement) => {
    this.root = root;
    this.sections = [...root.querySelectorAll<HTMLElement>('[data-form-section]')];
    const resize = new ResizeObserver(this.updateActive);
    resize.observe(root);
    for (const section of this.sections) {
      resize.observe(section);
    }
    const options = { capture: true, passive: true };
    window.addEventListener('scroll', this.onScroll, options);
    window.addEventListener('scrollend', this.onScrollEnd, options);
    window.addEventListener('wheel', this.onUserScroll, options);
    window.addEventListener('touchstart', this.onUserScroll, options);
    window.addEventListener('keydown', this.onKeyDown, options);
    window.addEventListener('resize', this.updateActive);
    this.updateActive();
    return () => {
      this.finishJump(false);
      resize.disconnect();
      window.removeEventListener('scroll', this.onScroll, options);
      window.removeEventListener('scrollend', this.onScrollEnd, options);
      window.removeEventListener('wheel', this.onUserScroll, options);
      window.removeEventListener('touchstart', this.onUserScroll, options);
      window.removeEventListener('keydown', this.onKeyDown, options);
      window.removeEventListener('resize', this.updateActive);
      this.root = null;
      this.sections = [];
    };
  };

  goToSection(id: string, { focus = false } = {}) {
    const section = this.sections.find((el) => el.dataset.formSection === id);
    if (!section) {
      return;
    }
    this.locked = id;
    this.finishJump(false);
    const scroller = this.scroller();
    const viewportTop =
      scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop;
    const offset = Number.parseFloat(getComputedStyle(section).scrollMarginTop) || 0;
    const target = Math.max(
      0,
      Math.min(
        scroller.scrollHeight - scroller.clientHeight,
        scroller.scrollTop + section.getBoundingClientRect().top - viewportTop - offset,
      ),
    );
    const jump = { scroller, target, frame: 0 };
    this.jump = jump;
    let position = scroller.scrollTop;
    let stillFrames = 0;
    // No-op jumps and browsers without scrollend must also release the programmatic-scroll guard.
    const settled = () => {
      stillFrames = scroller.scrollTop === position ? stillFrames + 1 : 0;
      position = scroller.scrollTop;
      if (stillFrames >= 2) {
        this.finishJump();
      } else {
        jump.frame = requestAnimationFrame(settled);
      }
    };
    jump.frame = requestAnimationFrame(settled);
    this.updateActive();
    section.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    if (focus) {
      section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    }
  }

  private scroller() {
    for (let el = this.root?.parentElement; el; el = el.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) {
        return el;
      }
    }
    return document.scrollingElement ?? document.documentElement;
  }

  private finishJump(reconcile = true) {
    if (this.jump) {
      cancelAnimationFrame(this.jump.frame);
      if (reconcile && Math.abs(this.jump.scroller.scrollTop - this.jump.target) > 1) {
        this.locked = null;
      }
      this.jump = null;
      if (reconcile) {
        this.updateActive();
      }
    }
  }

  private updateActive = () => {
    const first = this.sections[0];
    const last = this.sections.at(-1);
    const offset = first ? Number.parseFloat(getComputedStyle(first).scrollMarginTop) || 0 : 0;
    const scroller = this.scroller();
    const line =
      offset + (scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop);
    // A short final section wins only at the scroller's limit, not merely when it fits on screen.
    const atEnd = scroller.scrollTop > 0 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
    const current = atEnd ? last : this.sections.find((el) => el.getBoundingClientRect().bottom > line);
    const next = this.locked ?? current?.dataset.formSection ?? this.active ?? first?.dataset.formSection ?? null;
    if (next !== this.active) {
      this.active = next;
      for (const listener of this.listeners) {
        listener();
      }
    }
  };

  private scrollsForm(target: EventTarget | null) {
    return target === document || (target instanceof Element && this.root !== null && target.contains(this.root));
  }

  private onScroll = (event: Event) => {
    if (this.scrollsForm(event.target)) {
      if (!this.jump) {
        this.locked = null;
      }
      this.updateActive();
    }
  };

  private onScrollEnd = (event: Event) => {
    if (this.scrollsForm(event.target)) {
      this.finishJump();
    }
  };

  private onUserScroll = () => {
    this.finishJump(false);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) {
      this.onUserScroll();
    }
  };
}
