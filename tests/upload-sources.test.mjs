import assert from "node:assert/strict";
import test from "node:test";
import { applySourceDescription, filledFrom, findSource, nextPick, sourceKind, suggestSources, versionBanner } from "../frontend/src/uploads/sources.ts";

const list = [
  { source: "polona", current_version: 1, updated_at: "2026-08-01T00:00:00Z" },
  { source: "wolne_lektury", current_version: 2, updated_at: "2026-09-02T00:00:00Z" },
  { source: "wolne_media_pl", current_version: 1, updated_at: "2026-08-11T00:00:00Z" },
  { source: "media_wolne", current_version: 3, updated_at: "2026-08-12T00:00:00Z" },
];

const described = {
  source: "wolne_lektury", version: 2, job_id: "j", created_at: "2026-09-02T00:00:00Z", uploader: "anna",
  description: { pretty_name: "Wolne Lektury", description: "Classic Polish literature.", source_ref: "https://wolnelektury.pl/",
    publisher: "", domains: ["Books", "Poetry"], limitations: "" },
};

const form = (extra = {}) => ({ pipeline: "p", file: null, source: "wolne_lektury", added: "2026-10-16", license: "", author: "",
  source_ref: "", pretty_name: "", description: "", publisher: "", limitations: "", domains: [], per_record_provenance: false,
  declaration: false, ...extra });

test("suggestions put prefix matches before other matches and stay short", () => {
  assert.deepEqual(suggestSources(list, "wolne").map((s) => s.source), ["wolne_lektury", "wolne_media_pl", "media_wolne"]);
  assert.deepEqual(suggestSources(list, " WOLNE_L").map((s) => s.source), ["wolne_lektury"]);
  assert.equal(suggestSources(list, "").length, 4);
  const many = Array.from({ length: 20 }, (_, i) => ({ source: `s${i}`, current_version: 1, updated_at: "" }));
  assert.equal(suggestSources(many, "s").length, 8);
});

test("a name is new, existing or not given yet", () => {
  assert.equal(sourceKind(list, ""), "none");
  assert.equal(sourceKind(list, "wolne"), "new");
  assert.equal(sourceKind(list, "wolne_lektury"), "existing");
  assert.equal(findSource(list, "polona").current_version, 1);
  assert.equal(findSource(list, "nope"), null);
});

test("picking a source fills every description field from its current version", () => {
  const next = applySourceDescription(form({ pretty_name: "Mine", publisher: "Someone", domains: ["Web"] }), described, true);
  assert.equal(next.pretty_name, "Wolne Lektury");
  assert.equal(next.source_ref, "https://wolnelektury.pl/");
  assert.equal(next.publisher, "");
  assert.deepEqual(next.domains, ["Books"]);
});

test("without a pick only blank fields are filled, so edits after a failed job survive", () => {
  const edited = form({ pretty_name: "Edited", description: "My own words.", domains: ["Web"] });
  const next = applySourceDescription(edited, described, false);
  assert.equal(next.pretty_name, "Edited");
  assert.equal(next.description, "My own words.");
  assert.deepEqual(next.domains, ["Web"]);
  assert.equal(next.source_ref, "https://wolnelektury.pl/");
});

test("a description for another name than the form's is ignored", () => {
  const other = form({ source: "polona" });
  assert.equal(applySourceDescription(other, described, true), other);
});

test("the banner names the version and its uploader, or only the version", () => {
  assert.deepEqual(versionBanner(described), {
    title: "New version of source wolne_lektury (currently v2, uploaded by anna).",
    body: "It replaces the previous version entirely for everyone. The fields below are filled in from v2; change anything that is different now.",
  });
  assert.equal(versionBanner({ ...described, uploader: null }).title, "New version of source wolne_lektury (currently v2).");
  assert.equal(filledFrom(described), "Filled in from v2 · Wolne Lektury");
});

function wizard() {
  let state = { form: form({ source: "" }), picked: "" };
  const typed = (source) => {
    state = { form: { ...state.form, source }, picked: nextPick(state.picked, { kind: "source", source }) };
  };
  return {
    pick: (source) => {
      state = { form: { ...state.form, source }, picked: nextPick(state.picked, { kind: "picked", source, loaded: false }) };
      state.picked = nextPick(state.picked, { kind: "source", source });
    },
    failed: (source) => (state.picked = nextPick(state.picked, { kind: "settled", source })),
    arrived: (d) => {
      state = { form: applySourceDescription(state.form, d, state.picked === d.source), picked: nextPick(state.picked, { kind: "settled", source: d.source }) };
    },
    edit: (key, value) => (state.form = { ...state.form, [key]: value }),
    typed,
    get form() {
      return state.form;
    },
  };
}

test("a pick whose description failed to load does not force a later retype of the same name", () => {
  const w = wizard();
  w.pick("wolne_lektury");
  w.failed("wolne_lektury");
  w.edit("pretty_name", "Edited");
  w.typed("polona");
  w.typed("wolne_lektury");
  w.arrived(described);
  assert.equal(w.form.pretty_name, "Edited");
  assert.equal(w.form.source_ref, "https://wolnelektury.pl/");
});

test("typing away from a pick before its description arrives drops the pick", () => {
  const w = wizard();
  w.pick("wolne_lektury");
  w.edit("pretty_name", "Edited");
  w.edit("domains", ["Web"]);
  w.typed("wolne_lekt");
  w.typed("wolne_lektury");
  w.arrived(described);
  assert.equal(w.form.pretty_name, "Edited");
  assert.deepEqual(w.form.domains, ["Web"]);
});

test("a pick that is still pending forces the description when it arrives", () => {
  const w = wizard();
  w.edit("pretty_name", "Edited");
  w.pick("wolne_lektury");
  w.arrived(described);
  assert.equal(w.form.pretty_name, "Wolne Lektury");
});

test("a pick of the already loaded name is applied at once and leaves nothing pending", () => {
  assert.equal(nextPick("", { kind: "picked", source: "wolne_lektury", loaded: true }), "");
  assert.equal(nextPick("polona", { kind: "settled", source: "wolne_lektury" }), "polona");
});
