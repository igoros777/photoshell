/* PhotoShell UI - frontend logic */

document.addEventListener("DOMContentLoaded", function() {
    var form           = document.getElementById("workflow-form");
    var photoDirInput  = document.getElementById("photo_dir");
    var btnRun         = document.getElementById("btn-run");
    var btnCancel      = document.getElementById("btn-cancel");
    var btnBrowse      = document.getElementById("btn-browse");
    var btnValidate    = document.getElementById("btn-validate");
    var folderStatus   = document.getElementById("folder-status");
    var logPanel       = document.getElementById("log-panel");
    var progressBar    = document.getElementById("pipeline-progress");
    var stepsContainer = document.getElementById("pipeline-steps");

    // Folder browser modal elements
    var browserModal     = new bootstrap.Modal(document.getElementById("folderBrowserModal"));
    var browserPathInput = document.getElementById("browser-path-input");
    var browserGoBtn     = document.getElementById("browser-go-btn");
    var browserList      = document.getElementById("browser-list");
    var browserSelectBtn = document.getElementById("browser-select-btn");

    // Docs modal elements
    var docsModalEl  = document.getElementById("docsModal");
    var docsModal    = new bootstrap.Modal(docsModalEl);
    var docsTitle    = document.getElementById("docs-modal-title");
    var docsLoading  = document.getElementById("docs-loading");
    var docsContent  = document.getElementById("docs-content");

    var currentJobId = null;
    var pollTimer    = null;
    var folderValid  = false;
    var validateTimer = null;
    var pendingMermaidDivs = null; // mermaid divs waiting for modal shown event

    // ---- Initialize Bootstrap popovers for info tooltips ----

    document.querySelectorAll(".step-tooltip").forEach(function(el) {
        new bootstrap.Popover(el, {
            container: "body",
            placement: "top",
            html: false
        });
    });

    // ---- Documentation modal links ----

    document.querySelectorAll(".step-docs-link").forEach(function(el) {
        el.addEventListener("click", function(e) {
            e.stopPropagation();
            var docKey = el.dataset.doc;
            openDocsModal(docKey);
        });
    });

    function renderPendingMermaid() {
        if (!pendingMermaidDivs || pendingMermaidDivs.length === 0) return;
        var divs = pendingMermaidDivs;
        pendingMermaidDivs = null;
        mermaid.run({ nodes: divs }).catch(function(e) {
            console.warn("Mermaid rendering error:", e);
        });
    }

    // When the modal is fully visible (animation done), render mermaid
    docsModalEl.addEventListener("shown.bs.modal", function() {
        renderPendingMermaid();
    });

    function openDocsModal(docKey) {
        pendingMermaidDivs = null;
        docsLoading.style.display = "block";
        docsContent.innerHTML = "";
        docsContent.style.display = "none";
        docsTitle.innerHTML = '<i class="bi bi-book"></i> Loading...';
        docsModal.show();

        fetch("/api/docs/" + encodeURIComponent(docKey))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    docsLoading.style.display = "none";
                    docsContent.style.display = "block";
                    docsContent.innerHTML = '<div class="text-danger">Error: ' + data.error + '</div>';
                    return;
                }

                docsTitle.innerHTML = '<i class="bi bi-book"></i> ' + data.filename;

                // Let marked parse everything normally (mermaid blocks become
                // <pre><code class="language-mermaid">...</code></pre>)
                var html = marked.parse(data.content);
                docsLoading.style.display = "none";
                docsContent.innerHTML = html;
                docsContent.style.display = "block";

                // Find code blocks that marked tagged as language-mermaid,
                // replace the <pre> with a <div class="mermaid"> containing
                // the decoded text, then let mermaid render them.
                var codeBlocks = docsContent.querySelectorAll('code.language-mermaid');
                var mermaidDivs = [];
                for (var i = 0; i < codeBlocks.length; i++) {
                    var pre = codeBlocks[i].closest("pre");
                    if (!pre) continue;
                    // textContent automatically decodes &lt; &gt; &amp; etc.
                    var raw = codeBlocks[i].textContent;
                    var div = document.createElement("div");
                    div.className = "mermaid";
                    div.textContent = raw;
                    pre.parentNode.replaceChild(div, pre);
                    mermaidDivs.push(div);
                }

                if (mermaidDivs.length > 0) {
                    // Check if modal is already fully visible
                    if (docsModalEl.classList.contains("show")) {
                        // Modal already shown, render immediately
                        mermaid.run({ nodes: mermaidDivs }).catch(function(e) {
                            console.warn("Mermaid rendering error:", e);
                        });
                    } else {
                        // Modal still animating, defer until shown
                        pendingMermaidDivs = mermaidDivs;
                    }
                }
            })
            .catch(function(err) {
                docsLoading.style.display = "none";
                docsContent.style.display = "block";
                docsContent.innerHTML = '<div class="text-danger">Failed to load documentation: ' + err + '</div>';
            });
    }

    // ---- Step sequencing and order validation ----

    // Recommended order based on typical photo workflow logic.
    // Lower number = should run earlier.
    var STEP_RECOMMENDED_ORDER = {
        "enable_sync_exif":        1,
        "enable_gps_gap_fill":     2,
        "enable_extract_summary":  3,
        "enable_annotate_desc":    4,
        "enable_annotate_kw":      5,
        "enable_blur":             6,
        "enable_geo_rename":       7,
        "enable_gopro":            8,
        "enable_contact_sheet":    9,
        "enable_scrub":           10,
        "enable_search":          11
    };

    var STEP_LABELS = {
        "enable_sync_exif":       "Sync EXIF & Rename",
        "enable_gps_gap_fill":    "GPS Gap Fill",
        "enable_extract_summary": "Extract Photo Summary",
        "enable_annotate_desc":   "Annotate - Description",
        "enable_annotate_kw":     "Annotate - Keywords",
        "enable_blur":            "Detect Blurry Photos",
        "enable_geo_rename":      "Geo Rename Photos",
        "enable_gopro":           "GoPro Geo Rename",
        "enable_contact_sheet":   "Contact Sheet",
        "enable_scrub":           "Scrub Metadata",
        "enable_search":          "Search EXIF / IPTC"
    };

    // Why each dependency matters
    var ORDER_RULES = [
        {
            before: "enable_sync_exif",
            after: "enable_gps_gap_fill",
            reason: "Sync EXIF first so exported files have correct metadata before GPS gap filling reads timestamps."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_extract_summary",
            reason: "GPS Gap Fill should run before Extract Summary so the summary includes the filled-in location data."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_annotate_desc",
            reason: "GPS Gap Fill should run before annotation so descriptions can reference accurate location information."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_annotate_kw",
            reason: "GPS Gap Fill should run before keyword generation so location-based keywords are accurate."
        },
        {
            before: "enable_extract_summary",
            after: "enable_annotate_desc",
            reason: "Extract Summary writes technical metadata to comments first; Annotate Description can then build on that context."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_annotate_kw",
            reason: "Description annotation should run before keywords so the keyword prompt can leverage the generated description."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_contact_sheet",
            reason: "Annotate descriptions before generating the contact sheet so captions include the generated text."
        },
        {
            before: "enable_annotate_kw",
            after: "enable_contact_sheet",
            reason: "Generate keywords before the contact sheet so keyword metadata is available for captions."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_geo_rename",
            reason: "GPS Gap Fill should run before Geo Rename so filenames include the filled-in location."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_gopro",
            reason: "GPS Gap Fill should run before GoPro Geo Rename so clip names include accurate locations."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_scrub",
            reason: "Run annotation before scrubbing, otherwise scrub will clear the fields annotation writes to."
        },
        {
            before: "enable_annotate_kw",
            after: "enable_scrub",
            reason: "Run keyword annotation before scrubbing, otherwise scrub will clear the keyword fields."
        },
        {
            before: "enable_extract_summary",
            after: "enable_scrub",
            reason: "Run Extract Summary before scrubbing, otherwise scrub will clear the summary fields."
        }
    ];

    // Track selection order (keys in the order the user checked them)
    var selectionOrder = [];
    var orderWarningEl = document.getElementById("order-warning");

    // All step badges indexed by key
    var stepBadges = {};
    document.querySelectorAll(".step-badge[data-step-key]").forEach(function(el) {
        stepBadges[el.getAttribute("data-step-key")] = el;
    });

    function updateStepSequencing() {
        // Build the current selection order from selectionOrder
        // (only keep keys that are still checked)
        var activeOrder = [];
        for (var i = 0; i < selectionOrder.length; i++) {
            var key = selectionOrder[i];
            var cb = document.querySelector('input[name="' + key + '"]');
            if (cb && cb.checked) {
                activeOrder.push(key);
            }
        }
        selectionOrder = activeOrder;

        // Update all badges: show sequence number or reset
        for (var key in stepBadges) {
            var badge = stepBadges[key];
            var idx = activeOrder.indexOf(key);
            if (idx >= 0) {
                badge.textContent = "Step " + (idx + 1);
                badge.classList.remove("step-warn");
            } else {
                badge.textContent = "Step";
                badge.classList.remove("step-warn");
            }
        }

        // Check ordering violations
        var issues = [];
        for (var r = 0; r < ORDER_RULES.length; r++) {
            var rule = ORDER_RULES[r];
            var posB = activeOrder.indexOf(rule.before);
            var posA = activeOrder.indexOf(rule.after);
            // Only flag if both are selected and order is wrong
            if (posB >= 0 && posA >= 0 && posB > posA) {
                issues.push({
                    before: rule.before,
                    after: rule.after,
                    reason: rule.reason,
                    posB: posB,
                    posA: posA
                });
                // Mark both badges
                stepBadges[rule.before].classList.add("step-warn");
                stepBadges[rule.after].classList.add("step-warn");
            }
        }

        // Render the order warning
        if (issues.length === 0) {
            orderWarningEl.style.display = "none";
            orderWarningEl.classList.remove("expanded");
            return;
        }

        var html = '<div class="ow-header" onclick="this.parentElement.classList.toggle(\'expanded\')">';
        html += '<i class="bi bi-shuffle"></i> ';
        html += issues.length + ' step ordering ' + (issues.length === 1 ? 'concern' : 'concerns');
        html += ' <i class="bi bi-chevron-down" style="font-size:.65rem;margin-left:.3rem"></i>';
        html += '</div>';
        html += '<div class="ow-detail">';

        for (var j = 0; j < issues.length; j++) {
            var iss = issues[j];
            html += '<div class="ow-issue">';
            html += '<i class="bi bi-shuffle" style="font-size:.7rem"></i> ';
            html += '<strong>' + STEP_LABELS[iss.before] + '</strong>';
            html += ' (step ' + (iss.posB + 1) + ')';
            html += ' is typically run before ';
            html += '<strong>' + STEP_LABELS[iss.after] + '</strong>';
            html += ' (step ' + (iss.posA + 1) + ')';
            html += '</div>';
            html += '<div class="ow-issue" style="padding-left:1.1rem;color:#999;font-size:.75rem">';
            html += iss.reason;
            html += '</div>';
        }

        // Build suggested order
        var suggested = activeOrder.slice().sort(function(a, b) {
            return (STEP_RECOMMENDED_ORDER[a] || 99) - (STEP_RECOMMENDED_ORDER[b] || 99);
        });
        html += '<div class="ow-suggestion">';
        html += '<i class="bi bi-lightbulb" style="font-size:.7rem"></i> Suggested order: ';
        for (var k = 0; k < suggested.length; k++) {
            if (k > 0) html += ' &rarr; ';
            html += STEP_LABELS[suggested[k]];
        }
        html += '</div>';

        html += '</div>';

        orderWarningEl.innerHTML = html;
        orderWarningEl.style.display = "block";
    }

    // ---- Toggle accordion sections based on checkboxes in the header ----

    document.querySelectorAll(".section-toggle").forEach(function(cb) {
        var target = cb.dataset.section;
        var sec = document.getElementById(target);
        var item = sec ? sec.closest(".accordion-item") : null;
        if (!item) return;

        function syncState() {
            if (cb.checked) {
                item.classList.remove("disabled");
                // Track selection order: append if not already present
                if (selectionOrder.indexOf(cb.name) === -1) {
                    selectionOrder.push(cb.name);
                }
            } else {
                item.classList.add("disabled");
                var collapse = item.querySelector(".accordion-collapse");
                if (collapse && collapse.classList.contains("show")) {
                    bootstrap.Collapse.getOrCreateInstance(collapse).hide();
                }
                // Remove from selection order
                var idx = selectionOrder.indexOf(cb.name);
                if (idx >= 0) selectionOrder.splice(idx, 1);
            }
            updateStepSequencing();
        }

        cb.addEventListener("change", syncState);
        syncState();
    });

    // ---- Folder Validation ----

    function setFolderStatus(html, cls) {
        folderStatus.innerHTML = html;
        folderStatus.className = "mt-1 " + (cls || "");
    }

    function validateFolder(path) {
        if (!path) {
            setFolderStatus("");
            photoDirInput.classList.remove("is-valid", "is-invalid");
            folderValid = false;
            return;
        }

        setFolderStatus('<i class="bi bi-hourglass-split"></i> Checking...', "text-secondary");

        fetch("/api/validate_folder?path=" + encodeURIComponent(path))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (!data.valid) {
                    setFolderStatus(
                        '<i class="bi bi-x-circle-fill"></i> ' + data.reason,
                        "text-danger"
                    );
                    photoDirInput.classList.remove("is-valid");
                    photoDirInput.classList.add("is-invalid");
                    folderValid = false;
                } else if (data.warning) {
                    setFolderStatus(
                        '<i class="bi bi-exclamation-triangle-fill"></i> ' + data.warning +
                        ' <span class="text-muted">(resolved: ' + data.path + ')</span>',
                        "text-warning"
                    );
                    photoDirInput.classList.remove("is-invalid");
                    photoDirInput.classList.add("is-valid");
                    folderValid = true;
                } else {
                    setFolderStatus(
                        '<i class="bi bi-check-circle-fill"></i> ' +
                        data.photo_count + ' photo file' + (data.photo_count !== 1 ? 's' : '') +
                        ' found <span class="text-muted">(resolved: ' + data.path + ')</span>',
                        "text-success"
                    );
                    photoDirInput.classList.remove("is-invalid");
                    photoDirInput.classList.add("is-valid");
                    folderValid = true;
                }
            })
            .catch(function() {
                setFolderStatus(
                    '<i class="bi bi-x-circle-fill"></i> Validation request failed',
                    "text-danger"
                );
                folderValid = false;
            });
    }

    // Validate on button click
    btnValidate.addEventListener("click", function() {
        validateFolder(photoDirInput.value.trim());
    });

    // Auto-validate after typing stops (debounced 600ms)
    photoDirInput.addEventListener("input", function() {
        clearTimeout(validateTimer);
        var val = photoDirInput.value.trim();
        if (!val) {
            setFolderStatus("");
            photoDirInput.classList.remove("is-valid", "is-invalid");
            folderValid = false;
            return;
        }
        validateTimer = setTimeout(function() {
            validateFolder(val);
        }, 600);
    });

    // ---- Folder Browser ----

    function browseToPath(path) {
        browserList.innerHTML = '<div class="text-muted p-3"><i class="bi bi-hourglass-split"></i> Loading...</div>';
        browserPathInput.value = path;

        fetch("/api/browse?path=" + encodeURIComponent(path))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    browserList.innerHTML = '<div class="text-danger p-3">' + data.error + '</div>';
                    return;
                }

                browserPathInput.value = data.current;
                var html = "";

                // Parent directory link
                if (data.parent) {
                    html += '<div class="browser-item browser-parent" data-path="' +
                            escapeAttr(data.parent) + '">' +
                            '<i class="bi bi-arrow-up-circle"></i> ..' +
                            '</div>';
                }

                // Subdirectories
                if (data.dirs.length === 0 && !data.parent) {
                    html += '<div class="text-muted p-3">No subdirectories</div>';
                }

                for (var i = 0; i < data.dirs.length; i++) {
                    var fullPath = data.current + (data.current.endsWith("/") ? "" : "/") + data.dirs[i];
                    html += '<div class="browser-item" data-path="' + escapeAttr(fullPath) + '">' +
                            '<i class="bi bi-folder-fill" style="color:#aaa"></i> ' +
                            escapeHtml(data.dirs[i]) +
                            '</div>';
                }

                browserList.innerHTML = html;

                // Click handlers for directory items
                browserList.querySelectorAll(".browser-item").forEach(function(el) {
                    el.addEventListener("click", function() {
                        browseToPath(el.dataset.path);
                    });
                });
            })
            .catch(function() {
                browserList.innerHTML = '<div class="text-danger p-3">Failed to load directory</div>';
            });
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
                  .replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    btnBrowse.addEventListener("click", function() {
        var startPath = photoDirInput.value.trim() || "/";
        browseToPath(startPath);
        browserModal.show();
    });

    browserGoBtn.addEventListener("click", function() {
        browseToPath(browserPathInput.value.trim() || "/");
    });

    browserPathInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            browseToPath(browserPathInput.value.trim() || "/");
        }
    });

    browserSelectBtn.addEventListener("click", function() {
        var selected = browserPathInput.value.trim();
        if (selected) {
            photoDirInput.value = selected;
            validateFolder(selected);
        }
        browserModal.hide();
    });

    // ---- Collect form data ----

    function collectFormData() {
        var data = {};
        form.querySelectorAll("input[type=text], input[type=number], select").forEach(function(el) {
            if (el.name) data[el.name] = el.value.trim();
        });
        form.querySelectorAll("input[type=checkbox]").forEach(function(el) {
            if (el.name) data[el.name] = el.checked;
        });
        // Include the user's selection order so backend runs steps in this sequence
        data.step_order = selectionOrder.slice();
        return data;
    }

    // ---- Run pipeline ----

    btnRun.addEventListener("click", function() {
        var data = collectFormData();
        if (!data.photo_dir) {
            alert("Please specify a photo directory.");
            return;
        }

        // Validate folder before running
        if (!folderValid) {
            // Trigger a synchronous-style validation
            fetch("/api/validate_folder?path=" + encodeURIComponent(data.photo_dir))
                .then(function(res) { return res.json(); })
                .then(function(vdata) {
                    if (!vdata.valid) {
                        alert("Invalid photo directory: " + vdata.reason);
                        return;
                    }
                    folderValid = true;
                    startPipeline(data);
                })
                .catch(function() {
                    alert("Could not validate folder.");
                });
            return;
        }

        startPipeline(data);
    });

    function startPipeline(data) {
        var anyStep = Object.keys(data).some(function(k) {
            return k.indexOf("enable_") === 0 && data[k];
        });
        if (!anyStep) {
            alert("Please enable at least one workflow step.");
            return;
        }

        btnRun.disabled = true;
        btnCancel.style.display = "inline-block";
        logPanel.classList.add("active");
        logPanel.textContent = "Starting pipeline...\n";
        progressBar.classList.add("active");

        fetch("/api/run", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data),
        })
        .then(function(res) { return res.json(); })
        .then(function(body) {
            if (body.error) {
                logPanel.textContent = "Error: " + body.error;
                btnRun.disabled = false;
                btnCancel.style.display = "none";
                return;
            }
            currentJobId = body.job_id;
            renderStepBadges(body.steps);
            startPolling();
        })
        .catch(function(err) {
            logPanel.textContent = "Request failed: " + err;
            btnRun.disabled = false;
            btnCancel.style.display = "none";
        });
    }

    // ---- Cancel ----

    btnCancel.addEventListener("click", function() {
        if (!currentJobId) return;
        fetch("/api/cancel/" + currentJobId, {method: "POST"});
    });

    // ---- Polling ----

    function startPolling() {
        pollTimer = setInterval(function() {
            if (!currentJobId) return;
            fetch("/api/status/" + currentJobId)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    logPanel.textContent = data.log;
                    logPanel.scrollTop = logPanel.scrollHeight;
                    updateStepBadges(data);

                    if (data.status !== "running") {
                        clearInterval(pollTimer);
                        btnRun.disabled = false;
                        btnCancel.style.display = "none";
                        currentJobId = null;
                    }
                })
                .catch(function() { /* ignore transient errors */ });
        }, 1000);
    }

    // ---- Step badges ----

    function renderStepBadges(steps) {
        stepsContainer.innerHTML = "";
        steps.forEach(function(label, i) {
            var span = document.createElement("span");
            span.className = "pipeline-step";
            span.textContent = label;
            span.dataset.index = i;
            stepsContainer.appendChild(span);
        });
    }

    function updateStepBadges(data) {
        var badges = stepsContainer.querySelectorAll(".pipeline-step");
        badges.forEach(function(badge, i) {
            badge.classList.remove("running", "done", "failed");
            if (data.status === "done") {
                badge.classList.add("done");
            } else if (data.status === "failed" || data.status === "cancelled") {
                if (i < data.current_step)       badge.classList.add("done");
                else if (i === data.current_step) badge.classList.add("failed");
            } else {
                if (i < data.current_step)       badge.classList.add("done");
                else if (i === data.current_step) badge.classList.add("running");
            }
        });
    }
});
