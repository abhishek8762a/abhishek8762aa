// Sales Admin: create a new PO → S1 task for the S1 doer
import { sb, rpc, q } from "../sb.js";
import { stepOf, userName } from "../state.js";
import { esc, $, toast, toastError, busy, todayISO } from "../ui.js";
import { updateBadge } from "../app.js";

const PO_RE = /^PO\/\d{2}\/\d{2}\/\d{3,}$/;

export async function renderNewPO(page) {
  const [suggest, past] = await Promise.all([
    rpc("suggest_po_number"),
    q(sb.from("purchase_orders").select("series,model_no,lot_label").order("created_at", { ascending: false }).limit(1000)),
  ]);
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const series = uniq(["DEX", "ECO", ...past.map((p) => p.series)]);

  page.innerHTML = `
    <h1>New PO</h1>
    <form class="card" id="po-form" autocomplete="off">
      <div class="form-grid">
        <div class="field"><label class="f req">PO Number</label><input id="po_number" value="${esc(suggest)}" required>
          <div class="hint">Format PO/YY/MM/NNN — next number auto bhara hai.</div></div>
        <div class="field"><label class="f">Lot / Plan (sheet ka "Client name")</label><input id="lot_label" list="labels" placeholder="e.g. NOV 1st lot">
          <datalist id="labels">${uniq(past.map((p) => p.lot_label)).slice(0, 50).map((v) => `<option value="${esc(v)}">`).join("")}</datalist></div>
        <div class="field"><label class="f req">Series</label><input id="series" list="series-list" required>
          <datalist id="series-list">${series.map((s) => `<option value="${esc(s)}">`).join("")}</datalist></div>
        <div class="field"><label class="f req">Model No</label><input id="model_no" list="models" required>
          <datalist id="models">${uniq(past.map((p) => p.model_no)).map((v) => `<option value="${esc(v)}">`).join("")}</datalist></div>
        <div class="field"><label class="f req">Total Qty</label><input id="total_qty" type="number" min="1" step="1" inputmode="numeric" required></div>
        <div class="field"><label class="f">Unit Price (₹)</label><input id="unit_price" type="number" min="0" step="0.01" inputmode="decimal"></div>
        <div class="field"><label class="f">Expected Delivery</label><input id="expected_delivery" type="date" min="${todayISO()}"></div>
        <div class="field"><label class="f">Priority</label><div class="row">
          <label class="radio"><input type="radio" name="priority" value="NORMAL" checked> Normal</label>
          <label class="radio"><input type="radio" name="priority" value="URGENT"> Urgent</label></div></div>
      </div>
      <div class="field"><label class="f">Remarks</label><textarea id="remarks" maxlength="500"></textarea></div>
      <div id="dup"></div>
      <button class="btn primary big block" id="save">Create PO</button>
      <p class="small dim">Submit karte hi S1 (Partial WO) task ${esc(userName(stepOf("S1")?.doer_email))} ko chala jayega.</p>
    </form>
    <div id="done"></div>`;

  const form = $("#po-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#save");
    const po = $("#po_number").value.trim().toUpperCase();
    if (!PO_RE.test(po)) return toast("PO number format PO/YY/MM/NNN hona chahiye (jaise PO/26/10/043)", "error");
    const qty = Number($("#total_qty").value);
    if (!Number.isInteger(qty) || qty <= 0) return toast("Qty poora number aur 0 se zyada", "error");
    busy(btn, true);
    $("#dup").innerHTML = "";
    try {
      const res = await rpc("create_po", { p: {
        po_number: po,
        lot_label: $("#lot_label").value,
        series: $("#series").value,
        model_no: $("#model_no").value,
        total_qty: qty,
        unit_price: $("#unit_price").value,
        expected_delivery: $("#expected_delivery").value,
        priority: form.querySelector("input[name=priority]:checked").value,
        remarks: $("#remarks").value,
      } });
      toast(`${res.po_number} ban gaya ✓`);
      updateBadge();
      $("#done").innerHTML = `<div class="banner ok">${esc(res.po_number)} create ho gaya. S1 task: <a href="#/task/${res.task_id}">open</a></div>`;
      const next = await rpc("suggest_po_number");
      form.reset();
      $("#po_number").value = next;
      busy(btn, false);
    } catch (err) {
      busy(btn, false);
      const m = /Next available: (\S+)/.exec(err.message);
      if (m) {
        $("#dup").innerHTML = `<div class="banner red">Ye PO number pehle se hai. <button type="button" class="btn small" id="use-next">Use ${esc(m[1])}</button></div>`;
        $("#use-next").onclick = () => { $("#po_number").value = m[1]; $("#dup").innerHTML = ""; };
      } else toastError(err);
    }
  };
}
