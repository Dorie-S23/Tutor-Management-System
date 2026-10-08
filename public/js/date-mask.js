// Typed date and time fields: every date, month and time input gets a
// "dd/mm/yyyy" (or "mm/yyyy", "hh:mm") text field in front of it that
// formats as you type — the slashes and the colon appear by themselves as
// each segment completes, so nothing has to be tapped between day, month,
// year, hours and minutes.
//
// The native input stays in the DOM (hidden behind the typed field) and
// keeps its ISO "YYYY-MM-DD" / "HH:MM" value: page scripts still read and
// write element.value exactly as before, and required/min/readonly keep
// working — this file only replaces the typing surface and mirrors
// validation onto it.
(function () {
  const proto = window.HTMLInputElement.prototype;
  const valueDesc = Object.getOwnPropertyDescriptor(proto, "value");
  const requiredDesc = Object.getOwnPropertyDescriptor(proto, "required");
  const minDesc = Object.getOwnPropertyDescriptor(proto, "min");
  const maxDesc = Object.getOwnPropertyDescriptor(proto, "max");

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  // ISO "YYYY-MM-DD" → "15/01/2026"; ISO "YYYY-MM" → "01/2026"; a time is
  // already written the way it types ("HH:MM").
  function isoToDisplay(iso, kind) {
    const text = String(iso);
    if (kind === "time") return text;
    const parts = text.split("-");
    if (parts.length < 2) return "";
    if (kind === "month") return `${parts[1]}/${parts[0]}`;
    if (parts.length < 3) return "";
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  function digitsFrom(iso, kind) {
    const text = String(iso);
    if (kind === "time") {
      const parts = text.split(":");
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return pad2(parts[0]) + pad2(parts[1]);
      }
      return text.replace(/\D/g, "").slice(0, 4);
    }
    const parts = text.split("-");
    if (kind !== "month" && parts.length === 3 && parts[0].length === 4) {
      return pad2(parts[2]) + pad2(parts[1]) + parts[0];
    }
    if (parts.length >= 2 && parts[0].length === 4) {
      return pad2(parts[1]) + parts[0];
    }
    return text.replace(/\D/g, "").slice(0, kind === "month" ? 6 : 8);
  }

  // Splits a digit stream into its segments the way a person types them: a
  // first digit that can't begin a two-digit segment (4-9 for days, 2-9 for
  // months, 3-9 for hours, 6-9 for minutes) completes a one-digit segment
  // immediately — this is what lets "4/5/2026" and "9:30" flow with no
  // tapping in between.
  function segmentsOf(digits, kind) {
    let cursor = 0;

    function takeSegment(singleFrom) {
      if (cursor >= digits.length) {
        return { text: "", complete: false };
      }
      if (Number(digits[cursor]) >= singleFrom) {
        const text = digits[cursor];
        cursor += 1;
        return { text, complete: true };
      }
      const text = digits.slice(cursor, cursor + 2);
      cursor += text.length;
      return { text, complete: text.length === 2 };
    }

    if (kind === "time") {
      const hours = takeSegment(3);
      const minutes = takeSegment(6);
      return { hours, minutes };
    }

    const day = kind === "month" ? null : takeSegment(4);
    const month = takeSegment(2);
    const yearText = digits.slice(cursor, cursor + 4);
    return {
      day,
      month,
      year: { text: yearText, complete: yearText.length === 4 },
    };
  }

  // Digit stream → the masked text plus its ISO value ("" unless the
  // digits form a real, in-range value).
  function parse(digits, kind) {
    const segments = segmentsOf(digits, kind);

    if (kind === "time") {
      const { hours, minutes } = segments;
      let display = "";
      if (hours.text) {
        display += hours.complete ? pad2(hours.text) : hours.text;
        if (hours.complete) display += ":";
      }
      if (minutes.text && hours.complete) {
        display += minutes.complete ? pad2(minutes.text) : minutes.text;
      }
      const complete = hours.complete && minutes.complete;
      let valid = false;
      let iso = "";
      if (complete) {
        const h = Number(hours.text);
        const m = Number(minutes.text);
        valid = h <= 23 && m <= 59;
        if (valid) iso = `${pad2(h)}:${pad2(m)}`;
      }
      return { display, iso, complete, valid };
    }

    const { day, month, year } = segments;
    const monthOnly = kind === "month";
    let display = "";
    if (day && day.text) {
      display += day.complete ? pad2(day.text) : day.text;
      if (day.complete) display += "/";
    }
    if (month.text && (!day || day.complete)) {
      display += month.complete ? pad2(month.text) : month.text;
      if (month.complete) display += "/";
    }
    if (year.text && (!day || day.complete) && month.complete) {
      display += year.text;
    }

    const complete = (!day || day.complete) && month.complete && year.complete;
    let valid = false;
    let iso = "";
    if (complete) {
      const y = Number(year.text);
      const m = Number(month.text);
      const d = monthOnly ? 1 : Number(day.text);
      valid =
        y >= 1 &&
        m >= 1 &&
        m <= 12 &&
        (monthOnly || (d >= 1 && d <= daysInMonth(y, m)));
      if (valid) {
        iso = monthOnly
          ? `${year.text}-${pad2(m)}`
          : `${year.text}-${pad2(m)}-${pad2(d)}`;
      }
    }
    return { display, iso, complete, valid };
  }

  function uniqueId(base) {
    const stem = base || "date-field";
    let id = `${stem}-typed`;
    let n = 2;
    while (document.getElementById(id)) {
      id = `${stem}-typed-${n}`;
      n += 1;
    }
    return id;
  }

  // CSS.escape isn't available everywhere (jsdom lacks it), and ids are
  // tame in this app — escaping quotes/backslashes is enough for a selector.
  function escapeId(id) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(id);
    }
    return String(id).replace(/["\\]/g, "\\$&");
  }

  const CALENDAR_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4.5" width="18" height="16" rx="2"></rect>' +
    '<path d="M3 9.5h18M8 2.5v4M16 2.5v4"></path></svg>';
  const CLOCK_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';

  // The calendar/clock button beside a typed field, or null where the
  // browser can't open its picker on demand (typing is then the only way).
  function buildPickerButton(kind) {
    if (typeof proto.showPicker !== "function") return null;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "date-mask-picker";
    // Typing is the keyboard route, so the button stays out of tab order
    // rather than doubling every date field's tab stops.
    btn.tabIndex = -1;
    const noun = kind === "time" ? "time" : kind === "month" ? "month" : "date";
    btn.setAttribute("aria-label", `Choose ${noun}`);
    btn.title = `Choose ${noun}`;
    btn.innerHTML = kind === "time" ? CLOCK_ICON : CALENDAR_ICON;
    return btn;
  }

  function enhance(input) {
    if (input.dataset.dateMask === "on") return;
    input.dataset.dateMask = "on";

    const kind =
      input.type === "month"
        ? "month"
        : input.type === "time"
          ? "time"
          : "date";
    const monthOnly = kind === "month";
    const timeOnly = kind === "time";
    const maxDigits = timeOnly ? 4 : monthOnly ? 6 : 8;
    const state = { prevText: "", prevDigits: "", dispatching: false };

    const visible = document.createElement("input");
    visible.type = "text";
    visible.className = input.className;
    visible.classList.add("date-mask-input");
    visible.id = uniqueId(input.id);
    visible.placeholder = timeOnly
      ? "hh:mm"
      : monthOnly
        ? "mm/yyyy"
        : "dd/mm/yyyy";
    visible.setAttribute("autocomplete", "off");
    visible.setAttribute("inputmode", "numeric");
    visible.maxLength = timeOnly ? 5 : monthOnly ? 7 : 10;
    visible.readOnly = input.readOnly;
    visible.disabled = input.disabled;
    const ariaLabel = input.getAttribute("aria-label");
    if (ariaLabel) visible.setAttribute("aria-label", ariaLabel);

    // The typed field sits directly before the native input, so wrapped
    // labels (the first labelable descendant) and tab order both find it.
    // Both go in a wrapper with a picker button, which opens the browser's
    // own calendar/clock on the native input — a picked value flows back
    // into the typed field below, so either way of entering it works.
    const wrap = document.createElement("span");
    wrap.className = "date-mask-field";
    input.insertAdjacentElement("beforebegin", wrap);
    wrap.append(visible, input);
    const pickerBtn = buildPickerButton(kind);
    if (pickerBtn) {
      pickerBtn.hidden = input.readOnly || input.disabled;
      wrap.appendChild(pickerBtn);
    }
    input.classList.add("date-mask-native");
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    if (input.id) {
      document
        .querySelectorAll(`label[for="${escapeId(input.id)}"]`)
        .forEach((label) => {
          label.htmlFor = visible.id;
        });
    }

    // required/min/max move off the hidden native input — a control the
    // browser can't focus to show a message must never be the one to fail
    // validation. Property overrides keep them readable and keep dynamic
    // assignments (repeat-until dates and the like) working.
    let mirroredRequired = requiredDesc.get.call(input);
    let mirroredMin = minDesc.get.call(input);
    let mirroredMax = maxDesc.get.call(input);
    requiredDesc.set.call(input, false);
    input.removeAttribute("min");
    input.removeAttribute("max");
    visible.required = mirroredRequired;

    Object.defineProperty(input, "required", {
      configurable: true,
      get: () => mirroredRequired,
      set: (value) => {
        mirroredRequired = Boolean(value);
        visible.required = mirroredRequired;
      },
    });
    Object.defineProperty(input, "min", {
      configurable: true,
      get: () => mirroredMin,
      set: (value) => {
        mirroredMin = value == null ? "" : String(value);
        refreshValidation();
      },
    });
    Object.defineProperty(input, "max", {
      configurable: true,
      get: () => mirroredMax,
      set: (value) => {
        mirroredMax = value == null ? "" : String(value);
        refreshValidation();
      },
    });
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => valueDesc.get.call(input),
      set: (value) => {
        valueDesc.set.call(input, value);
        loadFromNative();
      },
    });

    function setText(text) {
      // Only write when the text really changes, so a keystroke that alters
      // nothing doesn't reset the caret for no reason.
      if (visible.value !== text) visible.value = text;
      try {
        visible.setSelectionRange(text.length, text.length);
      } catch {
        // The caret can't be positioned everywhere (e.g. unfocused in some
        // environments) — the value itself is what matters.
      }
    }

    function refreshValidation(current) {
      const parsed = current || parse(state.prevDigits, kind);
      const noun = timeOnly ? "time" : monthOnly ? "month" : "date";
      let message = "";
      if (state.prevDigits !== "") {
        if (!parsed.complete) {
          message = timeOnly
            ? "Enter the full time as hh:mm."
            : monthOnly
              ? "Enter the full month as mm/yyyy."
              : "Enter the full date as dd/mm/yyyy.";
        } else if (!parsed.valid) {
          message = timeOnly
            ? "That time doesn't exist — check the hours and minutes."
            : monthOnly
              ? "That month doesn't exist."
              : "That date doesn't exist — check the day and month.";
        } else if (mirroredMin && parsed.iso < mirroredMin) {
          message = `The ${noun} can't be before ${isoToDisplay(mirroredMin, kind)}.`;
        } else if (mirroredMax && parsed.iso > mirroredMax) {
          message = `The ${noun} can't be after ${isoToDisplay(mirroredMax, kind)}.`;
        }
      }
      visible.setCustomValidity(message);
      // The red state is for finished-but-wrong dates; a half-typed date
      // only carries the submit-time message.
      if (message !== "" && parsed.complete) {
        visible.setAttribute("aria-invalid", "true");
      } else {
        visible.removeAttribute("aria-invalid");
      }
    }

    // Write the digit stream out: mask the text, keep the native ISO value
    // in step, and (for typing) emit the same input/change events a native
    // field would when its value changes.
    function render(digits, fromUser) {
      const capped = digits.slice(0, maxDigits);
      const parsed = parse(capped, kind);
      state.prevText = parsed.display;
      state.prevDigits = capped;
      setText(parsed.display);
      if (fromUser && valueDesc.get.call(input) !== parsed.iso) {
        valueDesc.set.call(input, parsed.iso);
        state.dispatching = true;
        try {
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } finally {
          state.dispatching = false;
        }
      }
      refreshValidation(parsed);
    }

    function loadFromNative() {
      render(digitsFrom(valueDesc.get.call(input), kind), false);
    }

    // Typing the separator key ("1/", "9:" and so on) commits the segment
    // in progress by zero-padding it, so both hands can stay on the digits.
    function commitSeparator() {
      const segments = segmentsOf(state.prevDigits, kind);
      if (timeOnly) {
        const { hours, minutes } = segments;
        if (hours.text && !hours.complete) {
          render(pad2(hours.text), true);
          return;
        }
        if (hours.complete && minutes.text && !minutes.complete) {
          render(
            state.prevDigits.slice(0, -minutes.text.length) +
              pad2(minutes.text),
            true,
          );
        }
        return;
      }
      const { day, month } = segments;
      if (day && day.text && !day.complete) {
        render(pad2(day.text), true);
        return;
      }
      if ((!day || day.complete) && month.text && !month.complete) {
        render(
          state.prevDigits.slice(0, -month.text.length) + pad2(month.text),
          true,
        );
      }
    }

    visible.addEventListener("input", () => {
      const raw = visible.value;
      const isoTyped =
        kind === "date"
          ? /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/.exec(raw)
          : null;
      // A pasted "HH:MM" (or "H:MM", e.g. "2:30") lands in the right
      // segments — reading just the digits would turn "2:30" into "23:0".
      const timeTyped = timeOnly
        ? /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(raw)
        : null;
      let digits;
      if (isoTyped) {
        // A pasted "YYYY-MM-DD" lands in the right segments.
        digits = pad2(isoTyped[3]) + pad2(isoTyped[2]) + isoTyped[1];
      } else if (timeTyped) {
        digits = pad2(timeTyped[1]) + timeTyped[2];
      } else {
        digits = raw.replace(/\D/g, "");
        // Deleting a separator shrinks the text but not the digits — drop
        // the digit on the other side of it so Backspace keeps unwinding.
        if (digits === state.prevDigits && raw.length < state.prevText.length) {
          digits = digits.slice(0, -1);
        }
      }
      render(digits, true);
    });

    // "/" is the date separator key, ":" the time one (numpad "Divide"
    // counts as "/" too).
    const separatorKeys = timeOnly ? [":"] : ["/", "Divide"];
    visible.addEventListener("keydown", (event) => {
      if (
        separatorKeys.includes(event.key) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        commitSeparator();
      }
    });

    // Programmatic focus (labels, "New timesheet") belongs on the field
    // users can actually see and type into.
    input.addEventListener("focus", () => {
      visible.focus({ preventScroll: true });
    });

    if (pickerBtn) {
      pickerBtn.addEventListener("click", () => {
        if (visible.readOnly || visible.disabled) return;
        try {
          input.showPicker();
        } catch {
          // Some browsers refuse (e.g. no user activation) — typing still
          // works, so just put the caret there instead.
          visible.focus();
        }
      });
    }

    // A value chosen in the browser's picker lands on the native input
    // directly (an event this file didn't dispatch itself) — mirror it
    // into the typed field so the checks above run on it too. The page's
    // own listeners already received that same native event.
    function syncFromPicker(event) {
      if (state.dispatching) return;
      loadFromNative();
      visible.focus({ preventScroll: true });
    }
    input.addEventListener("input", syncFromPicker);
    input.addEventListener("change", syncFromPicker);

    // form.reset() can't fire value setters, so re-read the native input
    // once the browser's own reset has finished.
    const form = input.closest("form");
    if (form) {
      form.addEventListener("reset", () => {
        Promise.resolve().then(loadFromNative);
      });
    }

    // setAttribute()-style constraint changes (and readonly/disabled
    // toggles) move across the same way; property assignments are already
    // covered by the overrides above.
    const observed = ["required", "min", "max", "readonly", "disabled"];
    const observer = new MutationObserver(() => {
      observer.disconnect();
      if (requiredDesc.get.call(input)) {
        mirroredRequired = true;
        visible.required = true;
        requiredDesc.set.call(input, false);
      }
      const minValue = minDesc.get.call(input);
      if (minValue) {
        mirroredMin = minValue;
        input.removeAttribute("min");
      }
      const maxValue = maxDesc.get.call(input);
      if (maxValue) {
        mirroredMax = maxValue;
        input.removeAttribute("max");
      }
      visible.readOnly = input.readOnly;
      visible.disabled = input.disabled;
      if (pickerBtn) pickerBtn.hidden = input.readOnly || input.disabled;
      observer.observe(input, { attributes: true, attributeFilter: observed });
      refreshValidation();
    });
    observer.observe(input, { attributes: true, attributeFilter: observed });

    loadFromNative();
  }

  function enhanceDateInputs(root) {
    root
      .querySelectorAll(
        'input[type="date"], input[type="month"], input[type="time"]',
      )
      .forEach(enhance);
  }

  // Exposed so later-rendered forms can be masked too.
  window.enhanceDateInputs = enhanceDateInputs;

  enhanceDateInputs(document);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      enhanceDateInputs(document);
    });
  }
})();
