/* PhotoShell UI – frontend logic */

document.addEventListener("DOMContentLoaded", () => {
    const form        = document.getElementById("workflow-form");
    const btnRun      = document.getElementById("btn-run");
    const btnCancel   = document.getElementById("btn-cancel");
    const logPanel    = document.getElementById("log-panel");
    const progressBar = document.getElementById("pipeline-progress");
    const stepsContainer = document.getElementById("pipeline-steps");

    let currentJobId = null;
    let pollTimer    = null;

    // ---- Toggle accordion sections based on checkboxes in the header ----

    document.querySelectorAll(".section-toggle").forEach(cb => {
        const target = cb.dataset.section;
        const item   = document.getElementById(target)?.closest(".accordion-item");
        if (!item) return;

        const syncState = () => {
            if (cb.checked) {
                item.classList.remove("disabled");
            } else {
                item.classList.add("disabled");
                // collapse if open
                const collapse = item.querySelector(".accordion-collapse");
                if (collapse?.classList.contains("show")) {
                    bootstrap.Collapse.getOrCreateInstance(collapse).hide();
                }
            }
        };

        cb.addEventListener("change", syncState);
        syncState();
    });

    // ---- Collect form data ----

    function collectFormData() {
        const data = {};
        // text / select inputs
        form.querySelectorAll("input[type=text], input[type=number], select").forEach(el => {
            if (el.name) data[el.name] = el.value.trim();
        });
        // checkboxes
        form.querySelectorAll("input[type=checkbox]").forEach(el => {
            if (el.name) data[el.name] = el.checked;
        });
        return data;
    }

    // ---- Run pipeline ----

    btnRun.addEventListener("click", async () => {
        const data = collectFormData();
        if (!data.photo_dir) {
            alert("Please specify a photo directory.");
            return;
        }

        // Check at least one step enabled
        const anyStep = Object.keys(data).some(k => k.startsWith("enable_") && data[k]);
        if (!anyStep) {
            alert("Please enable at least one workflow step.");
            return;
        }

        btnRun.disabled = true;
        btnCancel.style.display = "inline-block";
        logPanel.classList.add("active");
        logPanel.textContent = "Starting pipeline...\n";
        progressBar.classList.add("active");

        try {
            const res  = await fetch("/api/run", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(data),
            });
            const body = await res.json();

            if (body.error) {
                logPanel.textContent = "Error: " + body.error;
                btnRun.disabled = false;
                btnCancel.style.display = "none";
                return;
            }

            currentJobId = body.job_id;
            renderStepBadges(body.steps);
            startPolling();

        } catch (err) {
            logPanel.textContent = "Request failed: " + err;
            btnRun.disabled = false;
            btnCancel.style.display = "none";
        }
    });

    // ---- Cancel ----

    btnCancel.addEventListener("click", async () => {
        if (!currentJobId) return;
        await fetch(`/api/cancel/${currentJobId}`, {method: "POST"});
    });

    // ---- Polling ----

    function startPolling() {
        pollTimer = setInterval(async () => {
            if (!currentJobId) return;
            try {
                const res  = await fetch(`/api/status/${currentJobId}`);
                const data = await res.json();

                logPanel.textContent = data.log;
                logPanel.scrollTop = logPanel.scrollHeight;
                updateStepBadges(data);

                if (data.status !== "running") {
                    clearInterval(pollTimer);
                    btnRun.disabled = false;
                    btnCancel.style.display = "none";
                    currentJobId = null;
                }
            } catch { /* ignore transient errors */ }
        }, 1000);
    }

    // ---- Step badges ----

    function renderStepBadges(steps) {
        stepsContainer.innerHTML = "";
        steps.forEach((label, i) => {
            const span = document.createElement("span");
            span.className = "pipeline-step";
            span.textContent = label;
            span.dataset.index = i;
            stepsContainer.appendChild(span);
        });
    }

    function updateStepBadges(data) {
        const badges = stepsContainer.querySelectorAll(".pipeline-step");
        badges.forEach((badge, i) => {
            badge.classList.remove("running", "done", "failed");
            if (data.status === "done") {
                badge.classList.add("done");
            } else if (data.status === "failed") {
                if (i < data.current_step)       badge.classList.add("done");
                else if (i === data.current_step) badge.classList.add("failed");
            } else if (data.status === "cancelled") {
                if (i < data.current_step)       badge.classList.add("done");
                else if (i === data.current_step) badge.classList.add("failed");
            } else {
                // running
                if (i < data.current_step)       badge.classList.add("done");
                else if (i === data.current_step) badge.classList.add("running");
            }
        });
    }
});
