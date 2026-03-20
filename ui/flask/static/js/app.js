/* PhotoShell UI - frontend logic */

document.addEventListener("DOMContentLoaded", function() {
    var form           = document.getElementById("workflow-form");
    var photoDirInput  = document.getElementById("photo_dir");
    var btnRun         = document.getElementById("btn-run");
    var btnCancel      = document.getElementById("btn-cancel");
    var btnBrowse      = document.getElementById("btn-browse");
    var btnValidate    = document.getElementById("btn-validate");
    var btnValidateWf  = document.getElementById("btn-validate-workflow");
    var validationResult = document.getElementById("validation-result");
    var advisoryPanel  = document.getElementById("advisory-panel");
    var folderStatus   = document.getElementById("folder-status");
    var folderMetaStats = document.getElementById("folder-meta-stats");
    var logPanel       = document.getElementById("log-panel");
    var progressBar    = document.getElementById("pipeline-progress");
    var stepsContainer = document.getElementById("pipeline-steps");
    var inspectorPanel = document.getElementById("inspector-panel");
    var inspectorTitle = document.getElementById("inspector-title");
    var inspectorContent = document.getElementById("inspector-content");

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
    var orderOverride = false; // user acknowledged ordering concerns

    // ---- Notification sounds (Web Audio API — no external files) ----

    function playSuccessSound() {
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Ascending two-note chime: C5 → E5
            [523.25, 659.25].forEach(function(freq, i) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.4);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(ctx.currentTime + i * 0.15);
                osc.stop(ctx.currentTime + i * 0.15 + 0.4);
            });
            setTimeout(function() { ctx.close(); }, 1000);
        } catch(e) { /* Audio not available */ }
    }

    function playErrorSound() {
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Descending two-note: E4 → C4
            [329.63, 261.63].forEach(function(freq, i) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = "triangle";
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.18, ctx.currentTime + i * 0.2);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.2 + 0.35);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(ctx.currentTime + i * 0.2);
                osc.stop(ctx.currentTime + i * 0.2 + 0.35);
            });
            setTimeout(function() { ctx.close(); }, 1000);
        } catch(e) { /* Audio not available */ }
    }

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
        docsTitle.innerHTML = '';
        var loadIcon = document.createElement('i');
        loadIcon.className = 'bi bi-book';
        docsTitle.appendChild(loadIcon);
        docsTitle.appendChild(document.createTextNode(' Loading...'));
        docsModal.show();

        fetch("/api/docs/" + encodeURIComponent(docKey))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    docsLoading.style.display = "none";
                    docsContent.style.display = "block";
                    docsContent.innerHTML = '';
                    var errDiv = document.createElement('div');
                    errDiv.className = 'text-danger';
                    errDiv.textContent = 'Error: ' + data.error;
                    docsContent.appendChild(errDiv);
                    return;
                }

                docsTitle.innerHTML = '';
                var icon = document.createElement('i');
                icon.className = 'bi bi-book';
                docsTitle.appendChild(icon);
                docsTitle.appendChild(document.createTextNode(' ' + data.filename));

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

                // Wire up internal doc links (open another doc in the same modal)
                docsContent.querySelectorAll(".docs-internal-link").forEach(function(link) {
                    link.addEventListener("click", function(ev) {
                        ev.preventDefault();
                        var targetDoc = link.getAttribute("data-doc");
                        if (targetDoc) openDocsModal(targetDoc);
                    });
                });
            })
            .catch(function(err) {
                docsLoading.style.display = "none";
                docsContent.style.display = "block";
                docsContent.innerHTML = '';
                var errDiv = document.createElement('div');
                errDiv.className = 'text-danger';
                errDiv.textContent = 'Failed to load documentation: ' + err;
                docsContent.appendChild(errDiv);
            });
    }

    // ---- Step sequencing and order validation ----

    var STEP_RECOMMENDED_ORDER = {
        "enable_sync_exif":        1,
        "enable_gps_gap_fill":     2,
        "enable_extract_summary":  3,
        "enable_annotate_desc":    4,
        "enable_annotate_kw":      5,
        "enable_geo_rename":       6,
        "enable_gopro":            7,
        "enable_blur":             8,
        "enable_contact_sheet":    9,
        "enable_scrub":           10
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
        "enable_scrub":           "Scrub Metadata"
    };

    // Map step keys to config panel IDs
    var STEP_CONFIG_MAP = {
        "enable_sync_exif":       "config-sync",
        "enable_gps_gap_fill":    "config-gps",
        "enable_extract_summary": "config-summary",
        "enable_annotate_desc":   "config-desc",
        "enable_annotate_kw":     "config-kw",
        "enable_blur":            "config-blur",
        "enable_geo_rename":      "config-geo",
        "enable_gopro":           "config-gopro",
        "enable_contact_sheet":   "config-cs",
        "enable_scrub":           "config-scrub"
    };

    // Map sidebar data-step attribute to step keys
    var SIDEBAR_STEP_MAP = {
        "sync":    "enable_sync_exif",
        "gps":     "enable_gps_gap_fill",
        "summary": "enable_extract_summary",
        "desc":    "enable_annotate_desc",
        "kw":      "enable_annotate_kw",
        "blur":    "enable_blur",
        "geo":     "enable_geo_rename",
        "gopro":   "enable_gopro",
        "cs":      "enable_contact_sheet",
        "scrub":   "enable_scrub"
    };

    var ORDER_RULES = [
        {
            before: "enable_sync_exif",
            after: "enable_gps_gap_fill",
            reason: "Sync EXIF copies metadata from originals to exports. GPS Gap Fill needs the synced timestamps to find donor photos."
        },
        {
            before: "enable_sync_exif",
            after: "enable_extract_summary",
            reason: "Sync EXIF must run first so exports have the original camera/lens/exposure data that Extract Summary reads."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_extract_summary",
            reason: "Extract Summary uses GPS for reverse geocoding. Without GPS Gap Fill, photos missing coordinates will have no location in their summary."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_annotate_desc",
            reason: "Descriptions reference location context. GPS must be filled first so the LLM prompt includes accurate location data."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_annotate_kw",
            reason: "Keywords include location-based tags. GPS must be filled first so location keywords are accurate."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_geo_rename",
            reason: "Geo Rename builds filenames from GPS coordinates. Without GPS Gap Fill, photos missing coordinates will not get location-based names."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_gopro",
            reason: "GoPro Geo Rename builds clip names from GPS coordinates. GPS must be filled first."
        },
        {
            before: "enable_extract_summary",
            after: "enable_annotate_desc",
            reason: "Extract Summary writes technical metadata (camera, exposure, location) to comment fields. The description prompt reads these fields for context."
        },
        {
            before: "enable_extract_summary",
            after: "enable_annotate_kw",
            reason: "Extract Summary writes technical metadata that the keyword prompt uses for context (location name, camera model, etc.)."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_annotate_kw",
            reason: "The keyword prompt reads the generated description to produce more relevant keywords. Descriptions must be written first."
        },
        {
            before: "enable_extract_summary",
            after: "enable_geo_rename",
            reason: "Extract Summary should run before renaming so the summary is written while files still have their original names."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_geo_rename",
            reason: "Annotations should complete before geo-renaming files, so metadata is fully written under the original filenames."
        },
        {
            before: "enable_annotate_kw",
            after: "enable_geo_rename",
            reason: "Keywords should be written before geo-renaming files."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_contact_sheet",
            reason: "Contact sheet captions use IPTC/EXIF descriptions. Annotate first so captions include the generated text."
        },
        {
            before: "enable_annotate_kw",
            after: "enable_contact_sheet",
            reason: "Generate keywords before the contact sheet so keyword metadata is available for captions."
        },
        {
            before: "enable_extract_summary",
            after: "enable_contact_sheet",
            reason: "Extract Summary should run before Contact Sheet so the summary text is available for captions."
        },
        {
            before: "enable_extract_summary",
            after: "enable_scrub",
            reason: "Scrub clears metadata fields that Extract Summary writes to. Run Extract Summary first or the summary will be erased."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_scrub",
            reason: "Scrub clears metadata fields that description annotation writes to. Annotate first or the descriptions will be erased."
        },
        {
            before: "enable_annotate_kw",
            after: "enable_scrub",
            reason: "Scrub clears keyword fields. Generate keywords first or they will be erased."
        },
        {
            before: "enable_contact_sheet",
            after: "enable_scrub",
            reason: "Contact sheet reads metadata for captions. Generate the contact sheet before scrubbing fields."
        },
        {
            before: "enable_geo_rename",
            after: "enable_scrub",
            reason: "Geo Rename should complete before scrubbing, as scrubbing may remove metadata that rename needs."
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
                badge.style.display = "";
                badge.classList.remove("step-warn");
            } else {
                badge.textContent = "";
                badge.style.display = "none";
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

        // Compute suggested order for reuse
        var suggested = activeOrder.slice().sort(function(a, b) {
            return (STEP_RECOMMENDED_ORDER[a] || 99) - (STEP_RECOMMENDED_ORDER[b] || 99);
        });

        // Render the order warning
        if (issues.length === 0) {
            orderWarningEl.style.display = "none";
            orderWarningEl.classList.remove("expanded");
            orderOverride = false;
            return;
        }

        // Reset override when issues change
        orderOverride = false;

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

        // Suggested order
        html += '<div class="ow-suggestion">';
        html += '<i class="bi bi-lightbulb" style="font-size:.7rem"></i> Suggested order: ';
        for (var k = 0; k < suggested.length; k++) {
            if (k > 0) html += ' &rarr; ';
            html += STEP_LABELS[suggested[k]];
        }
        html += '</div>';

        // Action buttons
        html += '<div class="ow-actions">';
        html += '<button type="button" class="btn btn-sm ow-btn-reorder" id="btn-use-suggested">';
        html += '<i class="bi bi-arrow-repeat"></i> Use suggested order</button>';
        html += '<button type="button" class="btn btn-sm ow-btn-override" id="btn-override-order">';
        html += '<i class="bi bi-unlock"></i> Keep my order</button>';
        html += '</div>';

        html += '</div>';

        orderWarningEl.innerHTML = html;
        orderWarningEl.style.display = "block";

        // Wire up the "Use suggested order" button
        document.getElementById("btn-use-suggested").addEventListener("click", function() {
            selectionOrder = suggested.slice();
            updateStepSequencing();
        });

        // Wire up the "Keep my order" override button
        document.getElementById("btn-override-order").addEventListener("click", function() {
            orderOverride = true;
            orderWarningEl.classList.add("ow-overridden");
            var overMsg = orderWarningEl.querySelector(".ow-override-msg");
            if (!overMsg) {
                var div = document.createElement("div");
                div.className = "ow-override-msg";
                div.innerHTML = '<i class="bi bi-exclamation-triangle"></i> '
                    + 'Order override active. The selected step sequence may produce '
                    + 'unexpected results if dependencies are not met.';
                orderWarningEl.querySelector(".ow-detail").appendChild(div);
            }
            // Hide action buttons after override
            var actions = orderWarningEl.querySelector(".ow-actions");
            if (actions) actions.style.display = "none";
        });
    }

    // Returns an object with validation results for pre-run check
    function validateWorkflow() {
        var result = { valid: true, errors: [], warnings: [] };
        var data = collectFormData();

        // 1) Folder check
        if (!data.photo_dir) {
            result.valid = false;
            result.errors.push("No photo directory specified.");
        } else if (!folderValid) {
            result.valid = false;
            result.errors.push("Photo directory has not been validated. Click the check button or type a valid path.");
        }

        // 2) At least one step
        var activeSteps = selectionOrder.filter(function(key) {
            return data[key];
        });
        if (activeSteps.length === 0) {
            result.valid = false;
            result.errors.push("No workflow steps are enabled.");
            return result;
        }

        // 3) Ordering issues
        var issues = [];
        for (var r = 0; r < ORDER_RULES.length; r++) {
            var rule = ORDER_RULES[r];
            var posB = activeSteps.indexOf(rule.before);
            var posA = activeSteps.indexOf(rule.after);
            if (posB >= 0 && posA >= 0 && posB > posA) {
                issues.push(rule);
            }
        }

        if (issues.length > 0 && !orderOverride) {
            result.valid = false;
            result.errors.push(
                issues.length + " step ordering " + (issues.length === 1 ? "concern" : "concerns")
                + " detected. Use the suggested order or click \"Keep my order\" to override."
            );
        } else if (issues.length > 0 && orderOverride) {
            result.warnings.push(
                "Running with " + issues.length + " order " + (issues.length === 1 ? "override" : "overrides")
                + ". Results may differ from expected behavior."
            );
        }

        // 5) Logical warnings (non-blocking)
        if (data.enable_scrub && (data.enable_annotate_desc || data.enable_annotate_kw || data.enable_extract_summary)) {
            var scrubPos = activeSteps.indexOf("enable_scrub");
            var writeSteps = ["enable_annotate_desc", "enable_annotate_kw", "enable_extract_summary"];
            var anyWriteAfter = writeSteps.some(function(ws) {
                var p = activeSteps.indexOf(ws);
                return p >= 0 && p > scrubPos;
            });
            if (anyWriteAfter) {
                result.warnings.push("Scrub Metadata is scheduled before a step that writes metadata. The scrubbed fields will be overwritten.");
            }
        }

        if (data.enable_geo_rename && data.enable_extract_summary) {
            var renPos = activeSteps.indexOf("enable_geo_rename");
            var sumPos = activeSteps.indexOf("enable_extract_summary");
            if (renPos >= 0 && sumPos >= 0 && renPos < sumPos) {
                result.warnings.push("Geo Rename will change filenames before Extract Summary runs. Summary log output will reference the new filenames.");
            }
        }

        return result;
    }

    // ---- Sidebar step clicking: show config in inspector ----

    document.querySelectorAll(".sidebar-step").forEach(function(el) {
        el.addEventListener("click", function(e) {
            // Don't navigate inspector when clicking checkbox, tooltip, or docs link
            if (e.target.classList.contains("form-check-input") ||
                e.target.classList.contains("step-tooltip") ||
                e.target.classList.contains("step-docs-link")) {
                return;
            }
            var stepKey = el.dataset.step;
            var enableKey = SIDEBAR_STEP_MAP[stepKey];

            // Remove active from all sidebar steps
            document.querySelectorAll(".sidebar-step").forEach(function(s) {
                s.classList.remove("active");
            });
            el.classList.add("active");

            // Return any currently-displayed config panel to its hidden state
            var currentConfig = inspectorContent.querySelector(".step-config");
            if (currentConfig) {
                currentConfig.style.display = "none";
                // Move it back to the form so collectFormData can still find it
                form.appendChild(currentConfig);
            }

            // Show the selected config in the inspector
            var configId = STEP_CONFIG_MAP[enableKey];
            var config = configId ? document.getElementById(configId) : null;
            if (config) {
                inspectorContent.appendChild(config);
                config.style.display = "block";
                inspectorTitle.textContent = STEP_LABELS[enableKey] || stepKey;
            } else {
                inspectorTitle.textContent = STEP_LABELS[enableKey] || stepKey;
            }
        });
    });

    // ---- Toggle step enable/disable based on checkboxes ----

    document.querySelectorAll(".section-toggle").forEach(function(cb) {
        function syncState() {
            if (cb.checked) {
                // Track selection order: append if not already present
                if (selectionOrder.indexOf(cb.name) === -1) {
                    selectionOrder.push(cb.name);
                }
            } else {
                // Remove from selection order
                var idx = selectionOrder.indexOf(cb.name);
                if (idx >= 0) selectionOrder.splice(idx, 1);
            }
            updateStepSequencing();
        }

        cb.addEventListener("change", function(e) {
            e.stopPropagation(); // Don't trigger sidebar-step click
            syncState();
        });
        syncState();
    });

    // ---- Header meta update ----

    function updateHeaderMeta(stats) {
        var meta = document.getElementById("header-meta");
        if (!meta) return;
        if (!stats) { meta.innerHTML = ''; return; }
        meta.innerHTML = '';
        // Path
        if (photoDirInput.value) {
            var pathEl = document.createElement('span');
            pathEl.className = 'header-meta-item';
            pathEl.textContent = photoDirInput.value;
            meta.appendChild(pathEl);
        }
        // Photo count
        if (stats.total !== undefined) {
            var countEl = document.createElement('span');
            countEl.className = 'header-meta-item';
            countEl.textContent = stats.total + ' photos';
            meta.appendChild(countEl);
        }
        // GPS %
        if (stats.pct_gps !== undefined) {
            var gpsEl = document.createElement('span');
            gpsEl.className = 'header-meta-item';
            gpsEl.textContent = stats.pct_gps + '% GPS';
            meta.appendChild(gpsEl);
        }
    }

    // ---- Pipeline strip ----

    function updatePipelineStrip(steps, currentStep, status) {
        var strip = document.getElementById("pipeline-strip");
        if (!strip) return;
        strip.style.display = "flex";
        strip.innerHTML = '';
        for (var i = 0; i < steps.length; i++) {
            if (i > 0) {
                var conn = document.createElement('div');
                conn.className = 'pipeline-connector';
                strip.appendChild(conn);
            }
            var node = document.createElement('div');
            node.className = 'pipeline-node';
            if (status === 'done' || i < currentStep) {
                node.classList.add('done');
                node.innerHTML = '<i class="bi bi-check-circle-fill"></i> ' + escapeHtml(steps[i]);
            } else if (i === currentStep && status === 'running') {
                node.classList.add('running');
                node.innerHTML = '<i class="bi bi-arrow-repeat"></i> ' + escapeHtml(steps[i]);
            } else if ((status === 'failed' || status === 'cancelled') && i === currentStep) {
                node.classList.add('failed');
                node.innerHTML = '<i class="bi bi-x-circle-fill"></i> ' + escapeHtml(steps[i]);
            } else {
                node.textContent = steps[i];
            }
            strip.appendChild(node);
        }
    }

    // ---- Folder Validation ----

    function setFolderStatus(html, cls) {
        folderStatus.innerHTML = html;
        folderStatus.className = "mt-1 " + (cls || "");
    }

    function validateFolder(path) {
        if (!path) {
            setFolderStatus("");
            hideFolderMetaStats();
            photoDirInput.classList.remove("is-valid", "is-invalid");
            folderValid = false;
            updateHeaderMeta(null);
            return;
        }

        setFolderStatus('<i class="bi bi-hourglass-split"></i> Checking...', "text-secondary");
        hideFolderMetaStats();

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
                    updateHeaderMeta(null);
                } else if (data.warning) {
                    setFolderStatus(
                        '<i class="bi bi-exclamation-triangle-fill"></i> ' + data.warning +
                        ' <span class="text-muted">(resolved: ' + data.path + ')</span>',
                        "text-warning"
                    );
                    photoDirInput.classList.remove("is-invalid");
                    photoDirInput.classList.add("is-valid");
                    folderValid = true;
                    autoDefaultMaxPerSheet(data.photo_count);
                    fetchFolderMetaStats(data.path);
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
                    autoDefaultMaxPerSheet(data.photo_count);
                    fetchFolderMetaStats(data.path);
                }
            })
            .catch(function() {
                setFolderStatus(
                    '<i class="bi bi-x-circle-fill"></i> Validation request failed',
                    "text-danger"
                );
                folderValid = false;
                updateHeaderMeta(null);
            });
    }

    function autoDefaultMaxPerSheet(photoCount) {
        var input = document.getElementById("cs-max-per-sheet");
        if (!input) return;
        // Only auto-set if the user hasn't manually changed it from the default
        var current = parseInt(input.value, 10);
        if (current === 0 && photoCount > 60) {
            input.value = "60";
        }
    }

    function hideFolderMetaStats() {
        folderMetaStats.style.display = "none";
        folderMetaStats.innerHTML = "";
    }

    function fetchFolderMetaStats(resolvedPath) {
        lastMetaPath = resolvedPath;
        folderMetaStats.innerHTML = '<span class="text-muted"><i class="bi bi-hourglass-split"></i> Scanning metadata...</span>';
        folderMetaStats.style.display = "block";

        fetch("/api/folder_meta?path=" + encodeURIComponent(resolvedPath))
            .then(function(res) {
                return res.json().then(function(data) {
                    return {ok: res.ok, data: data};
                });
            })
            .then(function(result) {
                if (!result.ok || result.data.error) {
                    var msg = (result.data && result.data.error) || "HTTP error";
                    folderMetaStats.innerHTML = '';
                    var span = document.createElement('span');
                    span.className = 'text-muted';
                    var warnIcon = document.createElement('i');
                    warnIcon.className = 'bi bi-exclamation-triangle';
                    span.appendChild(warnIcon);
                    span.appendChild(document.createTextNode(' ' + msg));
                    folderMetaStats.appendChild(span);
                    return;
                }
                renderFolderMetaStats(result.data);
                // Update header meta with stats
                updateHeaderMeta(result.data);
            })
            .catch(function(err) {
                folderMetaStats.innerHTML = '';
                var span = document.createElement('span');
                span.className = 'text-muted';
                var warnIcon = document.createElement('i');
                warnIcon.className = 'bi bi-exclamation-triangle';
                span.appendChild(warnIcon);
                span.appendChild(document.createTextNode(' Metadata scan unavailable: ' + (err.message || err)));
                folderMetaStats.appendChild(span);
            });
    }

    var lastMetaPath = "";  // track resolved path for "scan all" button

    function renderFolderMetaStats(d) {
        var isSampled = d.sampled < d.total;
        var sampleNote = isSampled
            ? " (sampled " + d.sampled + " of " + d.total + ")"
            : " (" + d.total + " files)";

        folderMetaStats.innerHTML = "";
        folderMetaStats.style.display = "block";

        var label = document.createElement("span");
        label.className = "fms-label";
        label.textContent = "Metadata coverage" + sampleNote + ":";
        folderMetaStats.appendChild(label);

        folderMetaStats.insertAdjacentHTML("beforeend",
            renderMetaStat("bi-geo-alt-fill", "GPS", d.has_gps, d.sampled, d.pct_gps) +
            renderMetaStat("bi-card-text", "IPTC Caption", d.has_caption, d.sampled, d.pct_caption) +
            renderMetaStat("bi-chat-square-text", "UserComment", d.has_comment, d.sampled, d.pct_comment) +
            renderMetaStat("bi-tags-fill", "Keywords", d.has_keywords || 0, d.sampled, d.pct_keywords || 0)
        );

        // Show "Scan all" button if this was a sample
        if (isSampled && lastMetaPath) {
            var scanBtn = document.createElement("button");
            scanBtn.type = "button";
            scanBtn.className = "btn btn-sm btn-photoshell";
            scanBtn.style.marginLeft = "auto";
            scanBtn.style.fontSize = "11px";
            scanBtn.style.padding = "2px 8px";
            scanBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Scan all ' + d.total;
            scanBtn.addEventListener("click", function() {
                scanBtn.disabled = true;
                scanBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Scanning...';
                fetch("/api/folder_meta?path=" + encodeURIComponent(lastMetaPath) + "&limit=0")
                    .then(function(res) { return res.json(); })
                    .then(function(data) {
                        if (data.error) {
                            scanBtn.textContent = "Error: " + data.error;
                            return;
                        }
                        renderFolderMetaStats(data);
                        updateHeaderMeta(data);
                    })
                    .catch(function() {
                        scanBtn.textContent = "Scan failed";
                    });
            });
            folderMetaStats.appendChild(scanBtn);
        }
    }

    function renderMetaStat(icon, label, count, total, pct) {
        var cls = "fms-none";
        if (pct >= 80) cls = "fms-good";
        else if (pct > 0) cls = "fms-partial";
        return '<span class="fms-stat ' + cls + '">'
            + '<i class="bi ' + icon + '"></i> '
            + label + ': ' + count + '/' + total
            + ' <small>(' + pct + '%)</small>'
            + '</span>';
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
            hideFolderMetaStats();
            photoDirInput.classList.remove("is-valid", "is-invalid");
            folderValid = false;
            updateHeaderMeta(null);
            return;
        }
        validateTimer = setTimeout(function() {
            validateFolder(val);
        }, 600);
    });

    // Validate immediately on paste (skip the 600ms debounce)
    photoDirInput.addEventListener("paste", function() {
        clearTimeout(validateTimer);
        setTimeout(function() {
            var val = photoDirInput.value.trim();
            if (val) validateFolder(val);
        }, 0);
    });

    // ---- Folder Browser ----

    var browserShowHidden = document.getElementById("browser-show-hidden");

    var browserDriveBar = null;
    var browserBreadcrumb = null;

    function ensureBrowserChrome() {
        if (browserDriveBar) return;
        var container = browserList.parentElement;
        var refNode = browserList;

        browserDriveBar = document.createElement("div");
        browserDriveBar.id = "browser-drive-bar";
        browserDriveBar.className = "browser-drive-bar";
        browserDriveBar.style.display = "none";
        container.insertBefore(browserDriveBar, refNode);

        browserBreadcrumb = document.createElement("div");
        browserBreadcrumb.id = "browser-breadcrumb";
        browserBreadcrumb.className = "browser-breadcrumb";
        container.insertBefore(browserBreadcrumb, refNode);
    }

    function browseToPath(path) {
        ensureBrowserChrome();
        browserList.innerHTML = '<div class="text-muted p-3"><i class="bi bi-hourglass-split"></i> Loading (network mounts may take a moment)...</div>';
        browserPathInput.value = path;

        var url = "/api/browse?path=" + encodeURIComponent(path);
        if (browserShowHidden && browserShowHidden.checked) {
            url += "&hidden=1";
        }
        fetch(url)
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    browserList.innerHTML = '<div class="text-danger p-3">'
                        + '<i class="bi bi-exclamation-triangle"></i> '
                        + escapeHtml(data.error) + '</div>';
                    return;
                }

                browserPathInput.value = data.current;

                // Drive bar (Windows / WSL)
                if (data.drives && data.drives.length > 0) {
                    var isWsl = data.platform === "wsl";
                    var driveHtml = '<span class="drive-label"><i class="bi bi-hdd"></i></span>';
                    for (var d = 0; d < data.drives.length; d++) {
                        var drv = data.drives[d];
                        var drvLetter = drv.charAt(0).toLowerCase();
                        var active = "";
                        if (isWsl) {
                            active = data.current.toLowerCase().startsWith("/mnt/" + drvLetter)
                                ? " drive-active" : "";
                        } else {
                            active = data.current.toUpperCase().startsWith(drv.toUpperCase())
                                ? " drive-active" : "";
                        }
                        driveHtml += '<button type="button" class="drive-btn' + active
                            + '" data-drive="' + escapeAttr(drv) + '">'
                            + escapeHtml(drv) + '</button>';
                    }
                    browserDriveBar.innerHTML = driveHtml;
                    browserDriveBar.style.display = "flex";
                    browserDriveBar.querySelectorAll(".drive-btn").forEach(function(btn) {
                        btn.addEventListener("click", function() {
                            browseToPath(btn.dataset.drive + "/");
                        });
                    });
                } else {
                    browserDriveBar.style.display = "none";
                }

                // Breadcrumb
                if (data.breadcrumb && data.breadcrumb.length > 0) {
                    var bcHtml = "";
                    for (var b = 0; b < data.breadcrumb.length; b++) {
                        var seg = data.breadcrumb[b];
                        if (b > 0) bcHtml += '<span class="bc-sep"><i class="bi bi-chevron-right"></i></span>';
                        var isLast = (b === data.breadcrumb.length - 1);
                        bcHtml += '<span class="bc-seg' + (isLast ? " bc-current" : "")
                            + '" data-path="' + escapeAttr(seg.path) + '">'
                            + escapeHtml(seg.name) + '</span>';
                    }
                    browserBreadcrumb.innerHTML = bcHtml;
                    browserBreadcrumb.style.display = "flex";
                    browserBreadcrumb.querySelectorAll(".bc-seg:not(.bc-current)").forEach(function(el) {
                        el.addEventListener("click", function() {
                            browseToPath(el.dataset.path);
                        });
                    });
                } else {
                    browserBreadcrumb.innerHTML = "";
                }

                var html = "";

                // Warning banner
                if (data.warning) {
                    html += '<div class="browser-warning">'
                         + '<i class="bi bi-exclamation-triangle"></i> '
                         + escapeHtml(data.warning) + '</div>';
                }

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
                    var dirEntry = data.dirs[i];
                    var dirName = typeof dirEntry === "string" ? dirEntry : dirEntry.name;
                    var fullPath = typeof dirEntry === "string" ? dirEntry : dirEntry.path;
                    html += '<div class="browser-item" data-path="' + escapeAttr(fullPath) + '">' +
                            '<i class="bi bi-folder-fill" style="color:var(--ps-text-dim)"></i> ' +
                            escapeHtml(dirName) +
                            '</div>';
                }

                browserList.innerHTML = html;

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

    browserShowHidden.addEventListener("change", function() {
        var current = browserPathInput.value.trim() || "/";
        browseToPath(current);
    });

    browserPathInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            browseToPath(browserPathInput.value.trim() || "/");
        }
    });

    browserPathInput.addEventListener("paste", function() {
        setTimeout(function() {
            var val = browserPathInput.value.trim();
            if (val) browseToPath(val);
        }, 0);
    });

    // Track which input the folder browser was opened for.
    var browserTarget = null;

    browserSelectBtn.addEventListener("click", function() {
        var selected = browserPathInput.value.trim();
        if (selected) {
            if (browserTarget === "backup-dest") {
                document.getElementById("backup-dest").value = selected;
            } else if (browserTarget === "search-dir") {
                document.getElementById("search-dir").value = selected;
                validateSearchDir(selected);
            } else if (browserTarget === "search-copy") {
                document.getElementById("search-copy-to").value = selected;
            } else {
                photoDirInput.value = selected;
                validateFolder(selected);
            }
        }
        browserTarget = null;
        browserModal.hide();
    });

    // ---- Search directory browse + validate ----

    var searchDirBrowseBtn = document.getElementById("btn-search-browse-dir");
    var searchDirValidateBtn = document.getElementById("btn-search-validate-dir");
    var searchCopyBrowseBtn = document.getElementById("btn-search-browse-copy");
    var searchDirStatus = document.getElementById("search-dir-status");

    if (searchDirBrowseBtn) {
        searchDirBrowseBtn.addEventListener("click", function() {
            browserTarget = "search-dir";
            var searchDir = document.getElementById("search-dir");
            var startPath = searchDir.value.trim() || photoDirInput.value.trim() || "/";
            browseToPath(startPath);
            browserModal.show();
        });
    }

    if (searchCopyBrowseBtn) {
        searchCopyBrowseBtn.addEventListener("click", function() {
            browserTarget = "search-copy";
            var copyTo = document.getElementById("search-copy-to");
            var startPath = copyTo.value.trim() || photoDirInput.value.trim() || "/";
            browseToPath(startPath);
            browserModal.show();
        });
    }

    function validateSearchDir(path) {
        if (!searchDirStatus) return;
        if (!path) { searchDirStatus.innerHTML = ""; return; }
        searchDirStatus.innerHTML = '<span class="text-muted"><i class="bi bi-arrow-repeat"></i> Checking...</span>';
        fetch("/api/validate_folder?path=" + encodeURIComponent(path))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.valid) {
                    var msg = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle-fill"></i> Valid</span>';
                    if (data.photo_count !== undefined) {
                        msg += ' <span class="text-muted">(' + data.photo_count + ' photos)</span>';
                    }
                    if (data.warning) {
                        msg += '<br><span style="color:var(--ps-warning);font-size:11px"><i class="bi bi-exclamation-triangle"></i> ' + data.warning + '</span>';
                    }
                    if (data.path) {
                        msg += '<br><span class="text-muted" style="font-size:11px">(resolved: ' + data.path + ')</span>';
                    }
                    searchDirStatus.innerHTML = msg;
                } else {
                    searchDirStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle-fill"></i> ' + (data.reason || "Invalid directory") + '</span>';
                }
            })
            .catch(function() {
                searchDirStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle-fill"></i> Validation failed</span>';
            });
    }

    if (searchDirValidateBtn) {
        searchDirValidateBtn.addEventListener("click", function() {
            validateSearchDir(document.getElementById("search-dir").value.trim());
        });
    }

    var searchCopyValidateBtn = document.getElementById("btn-search-validate-copy");
    var searchCopyStatus = document.getElementById("search-copy-status");

    function validateSearchCopy(path) {
        if (!searchCopyStatus) return;
        if (!path) { searchCopyStatus.innerHTML = ""; return; }
        searchCopyStatus.innerHTML = '<span class="text-muted"><i class="bi bi-arrow-repeat"></i> Checking...</span>';
        fetch("/api/validate_folder?path=" + encodeURIComponent(path))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.valid) {
                    var msg = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle-fill"></i> Valid</span>';
                    if (data.path) {
                        msg += ' <span class="text-muted" style="font-size:11px">(resolved: ' + data.path + ')</span>';
                    }
                    searchCopyStatus.innerHTML = msg;
                } else {
                    searchCopyStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle-fill"></i> ' + (data.reason || "Invalid directory") + '</span>';
                }
            })
            .catch(function() {
                searchCopyStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle-fill"></i> Validation failed</span>';
            });
    }

    if (searchCopyValidateBtn) {
        searchCopyValidateBtn.addEventListener("click", function() {
            validateSearchCopy(document.getElementById("search-copy-to").value.trim());
        });
    }

    // ---- Ollama model discovery ----

    var ollamaModelsFetched = false;

    function fetchOllamaModels() {
        if (ollamaModelsFetched) return;
        ollamaModelsFetched = true;

        var selects = document.querySelectorAll(".ollama-model-select");
        var statuses = document.querySelectorAll(".ollama-model-status");
        statuses.forEach(function(s) {
            s.innerHTML = '<span class="text-muted"><i class="bi bi-arrow-repeat"></i> Loading models...</span>';
        });

        fetch("/api/ollama_models")
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    statuses.forEach(function(s) {
                        s.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + data.error + '</span>';
                    });
                    ollamaModelsFetched = false;
                    return;
                }
                var models = data.models || [];
                if (models.length === 0) {
                    statuses.forEach(function(s) {
                        s.innerHTML = '<span style="color:var(--ps-warning)"><i class="bi bi-exclamation-triangle"></i> No models installed</span>';
                    });
                    return;
                }

                selects.forEach(function(sel) {
                    var currentVal = sel.value;
                    sel.innerHTML = "";

                    // Vision models group
                    var visionModels = models.filter(function(m) { return m.vision; });
                    var otherModels = models.filter(function(m) { return !m.vision; });

                    if (visionModels.length > 0) {
                        var vGroup = document.createElement("optgroup");
                        vGroup.label = "Vision models (recommended)";
                        visionModels.forEach(function(m) {
                            var opt = document.createElement("option");
                            opt.value = m.name;
                            opt.textContent = m.name + " (" + m.size_gb + " GB)";
                            vGroup.appendChild(opt);
                        });
                        sel.appendChild(vGroup);
                    }

                    if (otherModels.length > 0) {
                        var oGroup = document.createElement("optgroup");
                        oGroup.label = "Other models";
                        otherModels.forEach(function(m) {
                            var opt = document.createElement("option");
                            opt.value = m.name;
                            opt.textContent = m.name + " (" + m.size_gb + " GB)";
                            oGroup.appendChild(opt);
                        });
                        sel.appendChild(oGroup);
                    }

                    // Restore previous value if it exists, otherwise use server default
                    var found = false;
                    for (var i = 0; i < sel.options.length; i++) {
                        if (sel.options[i].value === currentVal) {
                            sel.value = currentVal;
                            found = true;
                            break;
                        }
                    }
                    if (!found && data.default) {
                        sel.value = data.default;
                    }
                });

                var vCount = models.filter(function(m) { return m.vision; }).length;
                var summary = models.length + " model" + (models.length !== 1 ? "s" : "");
                if (vCount > 0) {
                    summary += " (" + vCount + " vision)";
                }
                statuses.forEach(function(s) {
                    s.innerHTML = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle"></i> ' + summary + '</span>';
                });
            })
            .catch(function(err) {
                statuses.forEach(function(s) {
                    s.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> Failed to load models</span>';
                });
                ollamaModelsFetched = false;
            });
    }

    // Fetch models when a description or keywords step is clicked
    document.querySelectorAll('.sidebar-step[data-step="desc"], .sidebar-step[data-step="kw"]').forEach(function(el) {
        el.addEventListener("click", function() {
            fetchOllamaModels();
        });
    });

    // ---- Prompt management ----

    var promptCache = {};  // workflow -> [{id, text, source}, ...]

    function fetchPrompts(workflow) {
        if (promptCache[workflow]) {
            populatePromptSelect(workflow, promptCache[workflow]);
            return;
        }
        fetch("/api/prompts/" + encodeURIComponent(workflow))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) return;
                promptCache[workflow] = data.prompts || [];
                populatePromptSelect(workflow, promptCache[workflow]);
            })
            .catch(function() {});
    }

    function populatePromptSelect(workflow, prompts) {
        var prefix = workflow === "description" ? "desc" : "kw";
        var sel = document.getElementById(prefix + "-prompt-select");
        if (!sel) return;

        var currentVal = sel.value;
        sel.innerHTML = "";

        prompts.forEach(function(p) {
            var opt = document.createElement("option");
            opt.value = String(p.id);
            var label = p.id + " — " + p.text.substring(0, 80);
            if (p.text.length > 80) label += "...";
            if (p.source === "built-in") label += " (built-in)";
            opt.textContent = label;
            sel.appendChild(opt);
        });

        // Restore selection
        var found = false;
        for (var i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === currentVal) {
                sel.value = currentVal;
                found = true;
                break;
            }
        }
        if (!found && sel.options.length > 0) {
            // Default to first file prompt (id=1) or first available
            var filePrompt = prompts.find(function(p) { return p.source === "file"; });
            sel.value = filePrompt ? String(filePrompt.id) : String(prompts[0].id);
        }

        // Show the selected prompt text
        updatePromptText(workflow);
    }

    function updatePromptText(workflow) {
        var prefix = workflow === "description" ? "desc" : "kw";
        var sel = document.getElementById(prefix + "-prompt-select");
        var textarea = document.getElementById(prefix + "-prompt-text");
        if (!sel || !textarea) return;

        var prompts = promptCache[workflow] || [];
        var selectedId = sel.value;
        var prompt = prompts.find(function(p) { return String(p.id) === selectedId; });
        textarea.value = prompt ? prompt.text : "";
        textarea.readOnly = true;

        // Reset edit state
        var editBtn = document.getElementById(prefix + "-prompt-edit");
        var saveBtn = document.getElementById(prefix + "-prompt-save");
        var status = document.getElementById(prefix + "-prompt-status");
        if (editBtn) { editBtn.style.display = ""; editBtn.textContent = ""; editBtn.innerHTML = '<i class="bi bi-pencil"></i> Edit'; }
        if (saveBtn) saveBtn.style.display = "none";
        if (status) status.innerHTML = "";
    }

    // Wire up prompt select change events
    document.querySelectorAll(".prompt-select").forEach(function(sel) {
        sel.addEventListener("change", function() {
            updatePromptText(sel.dataset.workflow);
        });
    });

    // Wire up Edit buttons
    document.querySelectorAll(".prompt-edit-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var wf = btn.dataset.workflow;
            var prefix = wf === "description" ? "desc" : "kw";
            var textarea = document.getElementById(prefix + "-prompt-text");
            var saveBtn = document.getElementById(prefix + "-prompt-save");
            var sel = document.getElementById(prefix + "-prompt-select");

            if (textarea.readOnly) {
                // Enter edit mode
                textarea.readOnly = false;
                textarea.focus();
                textarea.style.borderColor = "var(--ps-accent)";
                btn.innerHTML = '<i class="bi bi-x-circle"></i> Cancel';
                if (saveBtn && sel.value !== "0") saveBtn.style.display = "";
            } else {
                // Cancel edit — restore original text
                textarea.readOnly = true;
                textarea.style.borderColor = "";
                updatePromptText(wf);
            }
        });
    });

    // Wire up Save buttons
    document.querySelectorAll(".prompt-save-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var wf = btn.dataset.workflow;
            var prefix = wf === "description" ? "desc" : "kw";
            var textarea = document.getElementById(prefix + "-prompt-text");
            var sel = document.getElementById(prefix + "-prompt-select");
            var status = document.getElementById(prefix + "-prompt-status");
            var promptId = sel.value;
            var promptText = textarea.value.trim();

            if (!promptText) {
                if (status) status.innerHTML = '<span style="color:var(--ps-danger)">Prompt text cannot be empty</span>';
                return;
            }
            if (promptId === "0") {
                if (status) status.innerHTML = '<span style="color:var(--ps-danger)">Cannot overwrite built-in prompt</span>';
                return;
            }

            if (status) status.innerHTML = '<span class="text-muted">Saving...</span>';

            fetch("/api/prompts/" + encodeURIComponent(wf) + "/save", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: parseInt(promptId), text: promptText})
            })
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    if (status) status.innerHTML = '<span style="color:var(--ps-danger)">' + data.error + '</span>';
                    return;
                }
                if (status) status.innerHTML = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle"></i> Saved</span>';
                // Update cache and UI
                textarea.readOnly = true;
                textarea.style.borderColor = "";
                btn.style.display = "none";
                var editBtn = document.getElementById(prefix + "-prompt-edit");
                if (editBtn) editBtn.innerHTML = '<i class="bi bi-pencil"></i> Edit';
                // Refresh prompts from server
                delete promptCache[wf];
                fetchPrompts(wf);
                // Clear status after 3s
                setTimeout(function() { if (status) status.innerHTML = ""; }, 3000);
            })
            .catch(function() {
                if (status) status.innerHTML = '<span style="color:var(--ps-danger)">Save failed</span>';
            });
        });
    });

    // Fetch prompts when annotate steps are clicked
    document.querySelectorAll('.sidebar-step[data-step="desc"]').forEach(function(el) {
        el.addEventListener("click", function() { fetchPrompts("description"); });
    });
    document.querySelectorAll('.sidebar-step[data-step="kw"]').forEach(function(el) {
        el.addEventListener("click", function() { fetchPrompts("keywords"); });
    });

    // ---- Collect form data ----

    function collectFormData() {
        var data = {};
        // Collect from both the sidebar form AND the inspector panel,
        // since step config panels are moved into the inspector (outside the form)
        var containers = [form, document.getElementById("inspector-content")];
        containers.forEach(function(container) {
            if (!container) return;
            container.querySelectorAll("input[type=text], input[type=number], select").forEach(function(el) {
                if (el.name) data[el.name] = el.value.trim();
            });
            container.querySelectorAll("input[type=checkbox]").forEach(function(el) {
                if (el.name) data[el.name] = el.checked;
            });
        });
        // Also collect from any step-config panels still in the form
        // (panels that haven't been clicked/moved to inspector yet)
        document.querySelectorAll(".step-config input[type=text], .step-config input[type=number], .step-config select").forEach(function(el) {
            if (el.name && !(el.name in data)) data[el.name] = el.value.trim();
        });
        document.querySelectorAll(".step-config input[type=checkbox]").forEach(function(el) {
            if (el.name && !(el.name in data)) data[el.name] = el.checked;
        });
        // Include the user's selection order so backend runs steps in this sequence
        data.step_order = selectionOrder.slice();
        return data;
    }

    // ---- Validate Workflow button ----

    btnValidateWf.addEventListener("click", function() {
        var path = photoDirInput.value.trim();

        // If folder not yet validated, do that first then show results
        if (path && !folderValid) {
            fetch("/api/validate_folder?path=" + encodeURIComponent(path))
                .then(function(res) { return res.json(); })
                .then(function(vdata) {
                    if (vdata.valid) {
                        folderValid = true;
                        photoDirInput.classList.remove("is-invalid");
                        photoDirInput.classList.add("is-valid");
                        if (vdata.warning) {
                            setFolderStatus(
                                '<i class="bi bi-exclamation-triangle-fill"></i> ' + vdata.warning,
                                "text-warning"
                            );
                        } else {
                            setFolderStatus(
                                '<i class="bi bi-check-circle-fill"></i> ' + vdata.photo_count + ' photo file'
                                + (vdata.photo_count !== 1 ? 's' : '') + ' found',
                                "text-success"
                            );
                        }
                    } else {
                        photoDirInput.classList.add("is-invalid");
                        setFolderStatus(
                            '<i class="bi bi-x-circle-fill"></i> ' + vdata.reason,
                            "text-danger"
                        );
                    }
                    showValidationWithPreflight();
                })
                .catch(function() {
                    setFolderStatus(
                        '<i class="bi bi-x-circle-fill"></i> Validation request failed',
                        "text-danger"
                    );
                    showValidationWithPreflight();
                });
            return;
        }

        showValidationWithPreflight();
    });

    function showValidationWithPreflight(callback) {
        var v = validateWorkflow();
        var data = collectFormData();

        // Run preflight tool check and advisory checks in parallel
        var preflightDone = false;
        var advisoryDone = false;
        var advisories = [];

        function onBothDone() {
            if (!preflightDone || !advisoryDone) return;
            showValidationResult(v);
            showAdvisoryPanel(advisories);
            if (callback) callback(v);
        }

        // Preflight
        fetch("/api/preflight", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data)
        })
        .then(function(res) { return res.json(); })
        .then(function(pf) {
            if (!pf.ok) {
                v.valid = false;
                for (var i = 0; i < pf.missing.length; i++) {
                    var m = pf.missing[i];
                    v.errors.push(
                        "Missing tool: " + m.label
                        + " (needed by: " + m.needed_by.join(", ") + ")"
                    );
                }
            }
            if (pf.ok && pf.tools && Object.keys(pf.tools).length > 0) {
                var toolNames = [];
                for (var t in pf.tools) {
                    toolNames.push(pf.tools[t].resolved);
                }
                v.toolsOk = toolNames;
            }
            preflightDone = true;
            onBothDone();
        })
        .catch(function() {
            v.warnings.push("Could not run tool preflight check.");
            preflightDone = true;
            onBothDone();
        });

        // Advisory checks (non-blocking, informational)
        fetch("/api/advisory", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data)
        })
        .then(function(res) { return res.json(); })
        .then(function(result) {
            advisories = result;
            advisoryDone = true;
            onBothDone();
        })
        .catch(function() {
            advisoryDone = true;
            onBothDone();
        });
    }

    function showAdvisoryPanel(advisories) {
        if (!advisories || advisories.length === 0) {
            advisoryPanel.style.display = "none";
            advisoryPanel.innerHTML = "";
            return;
        }

        var html = '<div class="adv-header">'
            + '<i class="bi bi-clipboard-pulse"></i> '
            + advisories.length + ' advisory '
            + (advisories.length === 1 ? 'note' : 'notes')
            + '</div>';

        for (var i = 0; i < advisories.length; i++) {
            var adv = advisories[i];
            var cls = adv.level === "warning" ? "adv-warn" : "adv-info";
            html += '<div class="adv-item ' + cls + '">';
            html += '<i class="bi ' + adv.icon + '"></i> ';
            html += '<strong>' + adv.title + '</strong>';
            html += '<div class="adv-detail">' + adv.detail + '</div>';
            html += '</div>';
        }

        advisoryPanel.innerHTML = html;
        advisoryPanel.style.display = "block";
    }

    function showValidationResult(v) {
        var html = "";
        var cls = "vr-pass";

        if (v.errors.length > 0) {
            cls = "vr-fail";
            for (var i = 0; i < v.errors.length; i++) {
                html += '<div class="vr-item vr-error"><i class="bi bi-x-circle" style="font-size:.75rem"></i> ' + v.errors[i] + '</div>';
            }
        }

        if (v.warnings.length > 0) {
            if (cls !== "vr-fail") cls = "vr-fail";
            for (var j = 0; j < v.warnings.length; j++) {
                html += '<div class="vr-item vr-warning"><i class="bi bi-exclamation-triangle" style="font-size:.75rem"></i> ' + v.warnings[j] + '</div>';
            }
        }

        if (v.errors.length === 0 && v.warnings.length === 0) {
            var msg = "Workflow is valid. Folder, steps, and ordering all check out.";
            if (v.toolsOk && v.toolsOk.length > 0) {
                msg += " Tools verified: " + v.toolsOk.join(", ") + ".";
            }
            html = '<div class="vr-item vr-ok"><i class="bi bi-check-circle" style="font-size:.75rem"></i> ' + msg + '</div>';
        }

        validationResult.innerHTML = html;
        validationResult.className = "validation-result " + cls;
        validationResult.style.display = "block";

        // Auto-hide after 10 seconds if all good
        if (v.valid && v.warnings.length === 0) {
            setTimeout(function() {
                validationResult.style.display = "none";
            }, 10000);
        }
    }

    // ---- Run pipeline ----

    btnRun.addEventListener("click", function() {
        var data = collectFormData();

        // If folder hasn't been validated yet, do it first then re-check
        if (data.photo_dir && !folderValid) {
            fetch("/api/validate_folder?path=" + encodeURIComponent(data.photo_dir))
                .then(function(res) { return res.json(); })
                .then(function(vdata) {
                    if (vdata.valid) {
                        folderValid = true;
                        photoDirInput.classList.remove("is-invalid");
                        photoDirInput.classList.add("is-valid");
                        if (vdata.warning) {
                            setFolderStatus(
                                '<i class="bi bi-exclamation-triangle-fill"></i> ' + vdata.warning,
                                "text-warning"
                            );
                        } else {
                            setFolderStatus(
                                '<i class="bi bi-check-circle-fill"></i> ' + vdata.photo_count + ' photo file'
                                + (vdata.photo_count !== 1 ? 's' : '') + ' found',
                                "text-success"
                            );
                        }
                    } else {
                        photoDirInput.classList.add("is-invalid");
                        setFolderStatus(
                            '<i class="bi bi-x-circle-fill"></i> ' + vdata.reason,
                            "text-danger"
                        );
                    }
                    // Now run the full validation
                    runWithValidation();
                })
                .catch(function() {
                    setFolderStatus(
                        '<i class="bi bi-x-circle-fill"></i> Validation request failed',
                        "text-danger"
                    );
                });
            return;
        }

        runWithValidation();
    });

    function runWithValidation() {
        showValidationWithPreflight(function(v) {
            // Hard errors: block execution
            if (!v.valid) {
                showPreRunDialog(v.errors, [], false);
                return;
            }

            // Warnings: show confirmation
            if (v.warnings.length > 0) {
                showPreRunDialog([], v.warnings, true);
                return;
            }

            // All clear
            startPipeline(collectFormData());
        });
    }

    function showPreRunDialog(errors, warnings, allowProceed) {
        var lines = [];

        if (errors.length > 0) {
            lines.push("CANNOT RUN:");
            for (var i = 0; i < errors.length; i++) {
                lines.push("  - " + errors[i]);
            }
        }

        if (warnings.length > 0) {
            if (lines.length > 0) lines.push("");
            lines.push("WARNINGS:");
            for (var j = 0; j < warnings.length; j++) {
                lines.push("  - " + warnings[j]);
            }
        }

        if (allowProceed) {
            lines.push("");
            lines.push("Proceed anyway?");
            if (confirm(lines.join("\n"))) {
                startPipeline(collectFormData());
            }
        } else {
            alert(lines.join("\n"));
        }
    }

    // Track pipeline step labels for strip visualization
    var pipelineStepLabels = [];

    function startPipeline(data) {
        btnRun.disabled = true;
        btnCancel.style.display = "inline-flex";
        logPanel.classList.add("active");
        progressBar.classList.add("active");

        // Scroll log panel into view so it's immediately visible
        setTimeout(function() {
            logPanel.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);

        // Show header with override notice if applicable
        var header = "Starting pipeline...\n";
        if (orderOverride) {
            header += "NOTE: Running with user-overridden step order.\n";
        }
        logPanel.textContent = header;

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
            pipelineStepLabels = body.steps || [];
            renderStepBadges(body.steps);
            // Initialize pipeline strip
            if (pipelineStepLabels.length > 0) {
                updatePipelineStrip(pipelineStepLabels, 0, "running");
            }
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

                    // Update pipeline strip
                    if (pipelineStepLabels.length > 0) {
                        updatePipelineStrip(pipelineStepLabels, data.current_step || 0, data.status);
                    }

                    if (data.status !== "running") {
                        clearInterval(pollTimer);
                        btnRun.disabled = false;
                        btnCancel.style.display = "none";
                        currentJobId = null;
                        // Play completion sound
                        if (data.status === "done") playSuccessSound();
                        else if (data.status === "failed" || data.status === "cancelled") playErrorSound();
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

    // ---- Standalone Search EXIF / IPTC ----

    var btnSearch       = document.getElementById("btn-search");
    var btnSearchCancel = document.getElementById("btn-search-cancel");
    var searchLog       = document.getElementById("search-log");
    var searchDirInput  = document.getElementById("search-dir");
    var searchQueryInput = document.getElementById("search-query");
    var searchJobId     = null;
    var searchPollTimer = null;

    // Wire up the docs link in the search panel
    var searchDocsLink = document.querySelector(".search-docs-link");
    if (searchDocsLink) {
        searchDocsLink.addEventListener("click", function(e) {
            e.stopPropagation();
            openDocsModal(searchDocsLink.dataset.doc);
        });
    }

    btnSearch.addEventListener("click", function() {
        var dir = searchDirInput.value.trim() || photoDirInput.value.trim();
        var query = searchQueryInput.value.trim();

        if (!dir) {
            alert("Please specify a directory to search in.");
            return;
        }
        if (!query) {
            alert("Please enter a search query.");
            return;
        }

        var payload = {
            photo_dir: dir,
            search_query: query,
            search_fields: document.getElementById("search-fields").value,
            search_media_types: document.getElementById("search-media-types").value,
            search_recursive: document.getElementById("search-recursive").checked,
            search_fzf: document.getElementById("search-fzf").checked,
            search_copy_to: document.getElementById("search-copy-to").value.trim()
        };

        btnSearch.disabled = true;
        btnSearchCancel.style.display = "inline-block";
        searchResultsEl.style.display = "none";
        searchResultsEl.innerHTML = "";
        searchLog.style.display = "block";
        searchLog.classList.add("active");
        searchLog.textContent = "Searching in " + dir + " ...\n";

        fetch("/api/search", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        })
        .then(function(res) { return res.json(); })
        .then(function(body) {
            if (body.error) {
                searchLog.textContent = "Error: " + body.error;
                btnSearch.disabled = false;
                btnSearchCancel.style.display = "none";
                return;
            }
            searchJobId = body.job_id;
            startSearchPolling();
        })
        .catch(function(err) {
            searchLog.textContent = "Request failed: " + err;
            btnSearch.disabled = false;
            btnSearchCancel.style.display = "none";
        });
    });

    btnSearchCancel.addEventListener("click", function() {
        if (!searchJobId) return;
        fetch("/api/cancel/" + searchJobId, {method: "POST"});
    });

    var searchResultsEl = document.getElementById("search-results");

    function startSearchPolling() {
        searchPollTimer = setInterval(function() {
            if (!searchJobId) return;
            fetch("/api/status/" + searchJobId)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    searchLog.textContent = data.log;
                    searchLog.scrollTop = searchLog.scrollHeight;
                    if (data.status !== "running") {
                        clearInterval(searchPollTimer);
                        btnSearch.disabled = false;
                        btnSearchCancel.style.display = "none";
                        searchJobId = null;
                        // Parse matched files from the log and fetch thumbnails
                        if (data.status === "done") {
                            renderSearchResults(data.log);
                        }
                    }
                })
                .catch(function() { /* ignore transient errors */ });
        }, 1000);
    }

    function renderSearchResults(log) {
        // Extract the resolved search directory from the log header
        // (the server normalizes it, e.g. C:\... -> /mnt/c/... on WSL)
        var dirMatch = log.match(/^Search directory:\s*(.+)$/m);
        var searchDir = dirMatch ? dirMatch[1].trim() : (searchDirInput.value.trim() || photoDirInput.value.trim());

        // Extract file paths from search output lines like "File: ./relative/path.jpg"
        var fileRegex = /^File:\s*(.+)$/gm;
        var match;
        var files = [];
        while ((match = fileRegex.exec(log)) !== null) {
            var f = match[1].trim();
            if (!f) continue;
            // Convert relative paths to absolute by prepending the resolved search dir
            if (f.startsWith("./")) {
                f = searchDir + "/" + f.substring(2);
            } else if (!f.startsWith("/") && !f.match(/^[A-Za-z]:/)) {
                f = searchDir + "/" + f;
            }
            files.push(f);
        }

        if (files.length === 0) {
            searchResultsEl.style.display = "none";
            return;
        }

        // Show loading state
        searchResultsEl.style.display = "block";
        searchResultsEl.innerHTML = '<div class="search-results-header">'
            + '<span><i class="bi bi-images"></i> ' + files.length + ' match' + (files.length !== 1 ? 'es' : '') + ' found</span>'
            + '<span class="text-muted">Loading metadata...</span></div>';

        // Fetch metadata for matched files
        fetch("/api/search_meta", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({files: files})
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            var results = data.results || [];
            var html = '<div class="search-results-header">'
                + '<span><i class="bi bi-images"></i> ' + results.length + ' match' + (results.length !== 1 ? 'es' : '') + '</span></div>';

            // Build a lookup by file path for metadata
            var metaMap = {};
            results.forEach(function(r) { metaMap[r.file] = r; });

            // Store metadata for modal use
            window._searchMetaMap = metaMap;
            window._searchFiles = files;

            // Render grid — use original file order
            html += '<div class="search-results-grid">';
            files.forEach(function(filepath, idx) {
                var m = metaMap[filepath] || {filename: filepath.split("/").pop(), comment: "", caption: "", keywords: ""};
                var thumbUrl = "/api/thumbnail?path=" + encodeURIComponent(filepath) + "&size=200";

                html += '<div class="search-result-card">';
                html += '<a href="#" class="photo-preview-link" data-idx="' + idx + '">';
                html += '<img src="' + thumbUrl + '" alt="' + escapeHtml(m.filename) + '" loading="lazy">';
                html += '</a>';
                html += '<div class="search-result-meta">';
                html += '<div class="search-result-filename" title="' + escapeHtml(filepath) + '">' + escapeHtml(m.filename) + '</div>';
                if (m.caption) {
                    html += '<div class="search-result-field"><span class="search-result-field-label">Caption:</span> ' + escapeHtml(m.caption) + '</div>';
                }
                if (m.comment) {
                    html += '<div class="search-result-field"><span class="search-result-field-label">Comment:</span> ' + escapeHtml(m.comment) + '</div>';
                }
                if (m.keywords) {
                    html += '<div class="search-result-field"><span class="search-result-field-label">Keywords:</span> ' + escapeHtml(m.keywords) + '</div>';
                }
                html += '</div></div>';
            });
            html += '</div>';

            searchResultsEl.innerHTML = html;
            wirePhotoPreviewLinks();
        })
        .catch(function() {
            // Fallback: show thumbnails without metadata
            window._searchMetaMap = {};
            window._searchFiles = files;
            var html = '<div class="search-results-header">'
                + '<span><i class="bi bi-images"></i> ' + files.length + ' matches</span></div>';
            html += '<div class="search-results-grid">';
            files.forEach(function(filepath, idx) {
                var fname = filepath.split("/").pop();
                var thumbUrl = "/api/thumbnail?path=" + encodeURIComponent(filepath) + "&size=200";
                html += '<div class="search-result-card">';
                html += '<a href="#" class="photo-preview-link" data-idx="' + idx + '"><img src="' + thumbUrl + '" alt="' + escapeHtml(fname) + '" loading="lazy"></a>';
                html += '<div class="search-result-meta"><div class="search-result-filename">' + escapeHtml(fname) + '</div></div>';
                html += '</div>';
            });
            html += '</div>';
            searchResultsEl.innerHTML = html;
            wirePhotoPreviewLinks();
        });
    }

    // ---- Structured Search ----

    var btnDiscoverFields      = document.getElementById("btn-discover-fields");
    var discoverStatus         = document.getElementById("discover-status");
    var structuredFieldsEl     = document.getElementById("structured-fields");
    var exifFilterList         = document.getElementById("exif-filter-list");
    var iptcFilterList         = document.getElementById("iptc-filter-list");
    var addFieldSelect         = document.getElementById("add-field-select");
    var btnStructuredSearch    = document.getElementById("btn-structured-search");
    var structuredSearchStatus = document.getElementById("structured-search-status");
    var structuredResultsHeader = document.getElementById("structured-results-header");

    // Full schema stored after discover
    var _discoveredSchema = null;

    // Track active filter field names to avoid duplicates
    var _activeFilters = {};

    if (btnDiscoverFields) {
        btnDiscoverFields.addEventListener("click", function() {
            discoverFields();
        });
    }

    if (btnStructuredSearch) {
        btnStructuredSearch.addEventListener("click", function() {
            runStructuredSearch();
        });
    }

    if (addFieldSelect) {
        addFieldSelect.addEventListener("change", function() {
            var val = addFieldSelect.value;
            if (!val || !_discoveredSchema) return;

            // Find the field in the schema
            var allFields = (_discoveredSchema.exif_fields || []).concat(_discoveredSchema.iptc_fields || []);
            var field = null;
            var group = null;
            for (var i = 0; i < allFields.length; i++) {
                if (allFields[i].name === val) {
                    field = allFields[i];
                    // Determine group
                    var isIptc = false;
                    for (var j = 0; j < (_discoveredSchema.iptc_fields || []).length; j++) {
                        if (_discoveredSchema.iptc_fields[j].name === val) { isIptc = true; break; }
                    }
                    group = isIptc ? "IPTC" : "EXIF";
                    break;
                }
            }

            if (field) {
                var targetList = group === "IPTC" ? iptcFilterList : exifFilterList;
                var row = renderFilterRow(field, group);
                targetList.appendChild(row);
                _activeFilters[val] = true;
                refreshAddFieldDropdown();
            }

            addFieldSelect.value = "";
        });
    }

    function discoverFields() {
        var dir = searchDirInput.value.trim() || photoDirInput.value.trim();
        if (!dir) {
            discoverStatus.innerHTML = '<span style="color:var(--ps-danger)">Please specify a directory first.</span>';
            return;
        }

        var recursive = document.getElementById("search-recursive").checked;
        discoverStatus.innerHTML = '<span class="text-muted"><i class="bi bi-arrow-repeat"></i> Discovering fields...</span>';
        btnDiscoverFields.disabled = true;

        var url = "/api/search/discover?path=" + encodeURIComponent(dir)
                + "&recursive=" + (recursive ? "1" : "0");

        fetch(url)
            .then(function(res) { return res.json(); })
            .then(function(data) {
                btnDiscoverFields.disabled = false;

                if (data.error) {
                    discoverStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + escapeHtml(data.error) + '</span>';
                    return;
                }

                _discoveredSchema = data;

                // Clear existing filter rows
                exifFilterList.innerHTML = "";
                iptcFilterList.innerHTML = "";
                _activeFilters = {};

                // Populate default fields
                var defaultFields = data.default_fields || [];
                var allExif = data.exif_fields || [];
                var allIptc = data.iptc_fields || [];

                defaultFields.forEach(function(dfName) {
                    // Find in EXIF first, then IPTC
                    var field = null;
                    var group = "EXIF";
                    for (var i = 0; i < allExif.length; i++) {
                        if (allExif[i].name === dfName) { field = allExif[i]; break; }
                    }
                    if (!field) {
                        for (var j = 0; j < allIptc.length; j++) {
                            if (allIptc[j].name === dfName) { field = allIptc[j]; group = "IPTC"; break; }
                        }
                    }
                    if (field) {
                        var targetList = group === "IPTC" ? iptcFilterList : exifFilterList;
                        var row = renderFilterRow(field, group);
                        targetList.appendChild(row);
                        _activeFilters[dfName] = true;
                    }
                });

                // Show the structured fields area
                structuredFieldsEl.style.display = "block";

                // Populate add-field dropdown
                refreshAddFieldDropdown();

                var statusMsg = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle"></i> '
                    + 'Sampled ' + (data.sampled || 0) + ' of ' + (data.total || 0) + ' files</span>';
                discoverStatus.innerHTML = statusMsg;
            })
            .catch(function(err) {
                btnDiscoverFields.disabled = false;
                discoverStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + escapeHtml(String(err)) + '</span>';
            });
    }

    function renderFilterRow(field, group) {
        var row = document.createElement("div");
        row.className = "structured-filter-row";
        row.dataset.fieldName = field.name;
        row.dataset.fieldGroup = group;
        row.dataset.fieldType = field.type;

        var nameSpan = document.createElement("span");
        nameSpan.className = "filter-name";
        nameSpan.textContent = field.name;
        row.appendChild(nameSpan);

        var inputsDiv = document.createElement("div");
        inputsDiv.className = "filter-inputs";

        if (field.type === "numeric") {
            var minInput = document.createElement("input");
            minInput.type = "number";
            minInput.className = "form-control form-control-sm";
            minInput.placeholder = field.min != null ? String(field.min) : "min";
            minInput.dataset.role = "min";
            if (field.min != null) minInput.title = "Min observed: " + field.min;
            inputsDiv.appendChild(minInput);

            var sep = document.createElement("span");
            sep.className = "range-sep";
            sep.textContent = "\u2014";
            inputsDiv.appendChild(sep);

            var maxInput = document.createElement("input");
            maxInput.type = "number";
            maxInput.className = "form-control form-control-sm";
            maxInput.placeholder = field.max != null ? String(field.max) : "max";
            maxInput.dataset.role = "max";
            if (field.max != null) maxInput.title = "Max observed: " + field.max;
            inputsDiv.appendChild(maxInput);

        } else if (field.type === "date") {
            var minDate = document.createElement("input");
            minDate.type = "date";
            minDate.className = "form-control form-control-sm";
            minDate.dataset.role = "min";
            if (field.min) minDate.title = "Earliest: " + field.min;
            inputsDiv.appendChild(minDate);

            var dateSep = document.createElement("span");
            dateSep.className = "range-sep";
            dateSep.textContent = "\u2014";
            inputsDiv.appendChild(dateSep);

            var maxDate = document.createElement("input");
            maxDate.type = "date";
            maxDate.className = "form-control form-control-sm";
            maxDate.dataset.role = "max";
            if (field.max) maxDate.title = "Latest: " + field.max;
            inputsDiv.appendChild(maxDate);

        } else if (field.type === "select" && field.values && field.values.length > 0) {
            var sel = document.createElement("select");
            sel.className = "form-select form-select-sm";
            sel.multiple = true;
            sel.dataset.role = "values";
            sel.style.maxWidth = "300px";
            sel.style.minHeight = "28px";
            field.values.forEach(function(v) {
                var opt = document.createElement("option");
                opt.value = v;
                opt.textContent = v;
                sel.appendChild(opt);
            });
            inputsDiv.appendChild(sel);

        } else {
            // text type
            var textInput = document.createElement("input");
            textInput.type = "text";
            textInput.className = "form-control form-control-sm";
            textInput.placeholder = field.sample ? "e.g. " + field.sample : "contains...";
            textInput.dataset.role = "value";
            textInput.style.maxWidth = "300px";
            inputsDiv.appendChild(textInput);
        }

        row.appendChild(inputsDiv);

        var removeBtn = document.createElement("button");
        removeBtn.className = "filter-remove";
        removeBtn.title = "Remove filter";
        removeBtn.innerHTML = '<i class="bi bi-x"></i>';
        removeBtn.addEventListener("click", function() {
            row.parentNode.removeChild(row);
            delete _activeFilters[field.name];
            refreshAddFieldDropdown();
        });
        row.appendChild(removeBtn);

        return row;
    }

    function refreshAddFieldDropdown() {
        if (!addFieldSelect || !_discoveredSchema) return;

        // Clear existing options
        addFieldSelect.innerHTML = '<option value="">+ Add field...</option>';

        var allExif = _discoveredSchema.exif_fields || [];
        var allIptc = _discoveredSchema.iptc_fields || [];

        if (allExif.length > 0) {
            var exifGroup = document.createElement("optgroup");
            exifGroup.label = "EXIF";
            allExif.forEach(function(f) {
                if (!_activeFilters[f.name]) {
                    var opt = document.createElement("option");
                    opt.value = f.name;
                    opt.textContent = f.name;
                    exifGroup.appendChild(opt);
                }
            });
            if (exifGroup.children.length > 0) {
                addFieldSelect.appendChild(exifGroup);
            }
        }

        if (allIptc.length > 0) {
            var iptcGroup = document.createElement("optgroup");
            iptcGroup.label = "IPTC";
            allIptc.forEach(function(f) {
                if (!_activeFilters[f.name]) {
                    var opt = document.createElement("option");
                    opt.value = f.name;
                    opt.textContent = f.name;
                    iptcGroup.appendChild(opt);
                }
            });
            if (iptcGroup.children.length > 0) {
                addFieldSelect.appendChild(iptcGroup);
            }
        }
    }

    function collectStructuredFilters() {
        var filters = [];
        var rows = document.querySelectorAll(".structured-filter-row");
        rows.forEach(function(row) {
            var fieldName = row.dataset.fieldName;
            var fieldType = row.dataset.fieldType;

            if (fieldType === "numeric" || fieldType === "date") {
                var minEl = row.querySelector('[data-role="min"]');
                var maxEl = row.querySelector('[data-role="max"]');
                var minVal = minEl ? minEl.value.trim() : "";
                var maxVal = maxEl ? maxEl.value.trim() : "";

                if (minVal || maxVal) {
                    var filter = {field: fieldName, op: "range"};
                    if (minVal) filter.min = fieldType === "numeric" ? parseFloat(minVal) : minVal;
                    if (maxVal) filter.max = fieldType === "numeric" ? parseFloat(maxVal) : maxVal;
                    filters.push(filter);
                }

            } else if (fieldType === "select") {
                var selEl = row.querySelector('[data-role="values"]');
                if (selEl) {
                    var selected = [];
                    for (var i = 0; i < selEl.options.length; i++) {
                        if (selEl.options[i].selected) {
                            selected.push(selEl.options[i].value);
                        }
                    }
                    if (selected.length > 0) {
                        filters.push({field: fieldName, op: "in", values: selected});
                    }
                }

            } else {
                // text
                var valEl = row.querySelector('[data-role="value"]');
                var val = valEl ? valEl.value.trim() : "";
                if (val) {
                    filters.push({field: fieldName, op: "contains", value: val});
                }
            }
        });
        return filters;
    }

    function runStructuredSearch() {
        var dir = searchDirInput.value.trim() || photoDirInput.value.trim();
        if (!dir) {
            structuredSearchStatus.innerHTML = '<span style="color:var(--ps-danger)">Please specify a directory.</span>';
            return;
        }

        var filters = collectStructuredFilters();
        if (filters.length === 0) {
            structuredSearchStatus.innerHTML = '<span style="color:var(--ps-danger)">Please set at least one filter value.</span>';
            return;
        }

        var recursive = document.getElementById("search-recursive").checked;

        btnStructuredSearch.disabled = true;
        structuredSearchStatus.innerHTML = '<span class="text-muted"><i class="bi bi-arrow-repeat"></i> Searching...</span>';
        searchResultsEl.style.display = "none";
        searchResultsEl.innerHTML = "";
        structuredResultsHeader.style.display = "none";

        fetch("/api/search/structured", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                path: dir,
                recursive: recursive,
                filters: filters,
                logic: "AND"
            })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            btnStructuredSearch.disabled = false;

            if (data.error) {
                structuredSearchStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + escapeHtml(data.error) + '</span>';
                return;
            }

            var results = data.results || [];
            var totalScanned = data.total_scanned || 0;

            structuredSearchStatus.innerHTML = '';
            structuredResultsHeader.style.display = "block";
            structuredResultsHeader.innerHTML = '<span><i class="bi bi-images"></i> '
                + results.length + ' match' + (results.length !== 1 ? 'es' : '')
                + ' of ' + totalScanned + ' scanned</span>';

            if (results.length === 0) {
                searchResultsEl.style.display = "none";
                return;
            }

            // Build file list and meta map for the shared results grid
            var files = [];
            var metaMap = {};
            results.forEach(function(r) {
                files.push(r.file);
                metaMap[r.file] = r;
            });

            window._searchFiles = files;
            window._searchMetaMap = metaMap;

            // Render the results grid
            var html = '<div class="search-results-header">'
                + '<span><i class="bi bi-images"></i> ' + results.length + ' match' + (results.length !== 1 ? 'es' : '') + '</span></div>';
            html += '<div class="search-results-grid">';
            files.forEach(function(filepath, idx) {
                var m = metaMap[filepath] || {filename: filepath.split("/").pop(), comment: "", caption: "", keywords: ""};
                var thumbUrl = "/api/thumbnail?path=" + encodeURIComponent(filepath) + "&size=200";

                html += '<div class="search-result-card">';
                html += '<a href="#" class="photo-preview-link" data-idx="' + idx + '">';
                html += '<img src="' + thumbUrl + '" alt="' + escapeHtml(m.filename) + '" loading="lazy">';
                html += '</a>';
                html += '<div class="search-result-meta">';
                html += '<div class="search-result-filename" title="' + escapeHtml(filepath) + '">' + escapeHtml(m.filename) + '</div>';
                if (m.caption) {
                    html += '<div class="search-result-field"><span class="search-result-field-label">Caption:</span> ' + escapeHtml(m.caption) + '</div>';
                }
                if (m.comment) {
                    html += '<div class="search-result-field"><span class="search-result-field-label">Comment:</span> ' + escapeHtml(m.comment) + '</div>';
                }
                if (m.keywords) {
                    html += '<div class="search-result-field"><span class="search-result-field-label">Keywords:</span> ' + escapeHtml(m.keywords) + '</div>';
                }
                html += '</div></div>';
            });
            html += '</div>';

            searchResultsEl.style.display = "block";
            searchResultsEl.innerHTML = html;
            wirePhotoPreviewLinks();
        })
        .catch(function(err) {
            btnStructuredSearch.disabled = false;
            structuredSearchStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + escapeHtml(String(err)) + '</span>';
        });
    }

    // ---- Photo preview modal ----

    var photoPreviewModal = new bootstrap.Modal(document.getElementById("photoPreviewModal"));
    var photoPreviewImg = document.getElementById("photo-preview-img");
    var photoPreviewTitle = document.getElementById("photo-preview-title");
    var photoPreviewFooter = document.getElementById("photo-preview-footer");

    function wirePhotoPreviewLinks() {
        searchResultsEl.querySelectorAll(".photo-preview-link").forEach(function(link) {
            link.addEventListener("click", function(e) {
                e.preventDefault();
                var idx = parseInt(link.dataset.idx, 10);
                openPhotoPreview(idx);
            });
        });
    }

    function openPhotoPreview(idx) {
        var files = window._searchFiles || [];
        var metaMap = window._searchMetaMap || {};
        if (idx < 0 || idx >= files.length) return;

        var filepath = files[idx];
        var m = metaMap[filepath] || {filename: filepath.split("/").pop(), comment: "", caption: "", keywords: ""};
        var fullUrl = "/api/thumbnail?path=" + encodeURIComponent(filepath) + "&size=1200";

        photoPreviewTitle.textContent = m.filename;
        photoPreviewImg.src = fullUrl;
        photoPreviewImg.alt = m.filename;

        // Build footer with metadata
        var footerHtml = '<div class="preview-meta-filename">' + escapeHtml(m.filename) + '</div>';
        if (m.caption) {
            footerHtml += '<div class="preview-meta-field"><span class="preview-meta-label">Caption</span>' + escapeHtml(m.caption) + '</div>';
        }
        if (m.comment) {
            footerHtml += '<div class="preview-meta-field"><span class="preview-meta-label">Summary</span>' + escapeHtml(m.comment) + '</div>';
        }
        if (m.keywords) {
            footerHtml += '<div class="preview-meta-field"><span class="preview-meta-label">Keywords</span>' + escapeHtml(m.keywords) + '</div>';
        }
        if (!m.caption && !m.comment && !m.keywords) {
            footerHtml += '<div class="preview-meta-field" style="color:var(--ps-text-dim)">No metadata available</div>';
        }
        photoPreviewFooter.innerHTML = footerHtml;

        photoPreviewModal.show();
    }

    // ---- Backup Folder ----

    var btnBackupEstimate = document.getElementById("btn-backup-estimate");
    var btnBackupRun      = document.getElementById("btn-backup-run");
    var btnBackupCancel   = document.getElementById("btn-backup-cancel");
    var backupLog         = document.getElementById("backup-log");
    var backupEstimateEl  = document.getElementById("backup-estimate");
    var backupDestInput   = document.getElementById("backup-dest");
    var backupRecursive   = document.getElementById("backup-recursive");
    var backupJobId       = null;
    var backupPollTimer   = null;

    document.getElementById("btn-backup-browse-dest").addEventListener("click", function() {
        browserTarget = "backup-dest";
        var startPath = backupDestInput.value.trim() || photoDirInput.value.trim() || "/";
        browseToPath(startPath);
        browserModal.show();
    });

    function getBackupPayload() {
        return {
            source: photoDirInput.value.trim(),
            dest: backupDestInput.value.trim(),
            recursive: backupRecursive.checked
        };
    }

    btnBackupEstimate.addEventListener("click", function() {
        var payload = getBackupPayload();
        if (!payload.source) {
            alert("Please specify a source folder or set a workflow directory.");
            return;
        }

        backupEstimateEl.innerHTML = '<span class="text-muted"><i class="bi bi-hourglass-split"></i> Estimating...</span>';
        backupEstimateEl.style.display = "block";

        fetch("/api/backup/estimate", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.error) {
                backupEstimateEl.innerHTML = '<span class="be-error"><i class="bi bi-x-circle"></i> ' + escapeHtml(data.error) + '</span>';
                return;
            }

            var html = '<div class="be-grid">';
            html += '<div class="be-item"><span class="be-label">Source</span><span class="be-value">' + escapeHtml(data.source) + '</span></div>';
            html += '<div class="be-item"><span class="be-label">Destination</span><span class="be-value">' + escapeHtml(data.dest) + '</span></div>';
            html += '<div class="be-item"><span class="be-label">Files</span><span class="be-value">' + data.file_count;
            if (data.recursive && data.dir_count > 0) {
                html += ' <small>(' + data.dir_count + ' subdirs)</small>';
            }
            html += '</span></div>';
            html += '<div class="be-item"><span class="be-label">Source size</span><span class="be-value">' + escapeHtml(data.size_human) + '</span></div>';
            html += '<div class="be-item"><span class="be-label">Est. archive</span><span class="be-value">' + escapeHtml(data.estimated_archive_human) + '</span></div>';

            var spaceClass = data.space_ok ? "be-space-ok" : "be-space-warn";
            html += '<div class="be-item"><span class="be-label">Available space</span><span class="be-value ' + spaceClass + '">' + escapeHtml(data.avail_human);
            if (!data.space_ok) {
                html += ' <i class="bi bi-exclamation-triangle-fill"></i> insufficient';
            }
            html += '</span></div>';
            html += '</div>';

            backupEstimateEl.innerHTML = html;
        })
        .catch(function(err) {
            backupEstimateEl.innerHTML = '<span class="be-error"><i class="bi bi-x-circle"></i> Estimate failed: ' + escapeHtml(String(err)) + '</span>';
        });
    });

    btnBackupRun.addEventListener("click", function() {
        var payload = getBackupPayload();
        if (!payload.source) {
            alert("Please specify a source folder or set a workflow directory.");
            return;
        }

        btnBackupRun.disabled = true;
        btnBackupEstimate.disabled = true;
        btnBackupCancel.style.display = "inline-block";
        backupLog.style.display = "block";
        backupLog.classList.add("active");
        backupLog.textContent = "Starting backup of " + payload.source + " ...\n";

        fetch("/api/backup/run", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        })
        .then(function(res) { return res.json(); })
        .then(function(body) {
            if (body.error) {
                backupLog.textContent = "Error: " + body.error;
                btnBackupRun.disabled = false;
                btnBackupEstimate.disabled = false;
                btnBackupCancel.style.display = "none";
                return;
            }
            backupJobId = body.job_id;
            startBackupPolling();
        })
        .catch(function(err) {
            backupLog.textContent = "Request failed: " + err;
            btnBackupRun.disabled = false;
            btnBackupEstimate.disabled = false;
            btnBackupCancel.style.display = "none";
        });
    });

    btnBackupCancel.addEventListener("click", function() {
        if (!backupJobId) return;
        fetch("/api/cancel/" + backupJobId, {method: "POST"});
    });

    function startBackupPolling() {
        backupPollTimer = setInterval(function() {
            if (!backupJobId) return;
            fetch("/api/status/" + backupJobId)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    backupLog.textContent = data.log;
                    backupLog.scrollTop = backupLog.scrollHeight;
                    if (data.status !== "running") {
                        clearInterval(backupPollTimer);
                        btnBackupRun.disabled = false;
                        btnBackupEstimate.disabled = false;
                        btnBackupCancel.style.display = "none";
                        backupJobId = null;
                    }
                })
                .catch(function() { /* ignore transient errors */ });
        }, 1000);
    }

    // ---- Keyboard shortcuts ----

    document.addEventListener("keydown", function(e) {
        // Don't fire shortcuts when typing in inputs/textareas
        var tag = document.activeElement ? document.activeElement.tagName : "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        if (e.key === "r" || e.key === "R") {
            e.preventDefault();
            if (!btnRun.disabled) btnRun.click();
        } else if (e.key === "Escape") {
            e.preventDefault();
            if (btnCancel.style.display !== "none") btnCancel.click();
        } else if (e.key === "/") {
            e.preventDefault();
            photoDirInput.focus();
        } else if (e.key === "v" || e.key === "V") {
            e.preventDefault();
            if (btnValidateWf) btnValidateWf.click();
        } else if (e.key === "?") {
            e.preventDefault();
            openDocsModal("web_ui_help");
        }
    });
});
