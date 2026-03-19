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

            // Hide all step configs
            document.querySelectorAll(".step-config").forEach(function(panel) {
                panel.style.display = "none";
            });

            // Show the selected config in the inspector
            var configId = STEP_CONFIG_MAP[enableKey];
            var config = configId ? document.getElementById(configId) : null;
            if (config) {
                // Move config content into inspector
                inspectorContent.innerHTML = "";
                inspectorContent.appendChild(config);
                config.style.display = "block";
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

    function hideFolderMetaStats() {
        folderMetaStats.style.display = "none";
        folderMetaStats.innerHTML = "";
    }

    function fetchFolderMetaStats(resolvedPath) {
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

    function renderFolderMetaStats(d) {
        var sampleNote = d.sampled < d.total
            ? " (sampled " + d.sampled + " of " + d.total + ")"
            : "";

        var html = '<span class="fms-label">Metadata coverage' + sampleNote + ':</span>';

        html += renderMetaStat("bi-geo-alt-fill", "GPS", d.has_gps, d.sampled, d.pct_gps);
        html += renderMetaStat("bi-card-text", "IPTC Caption", d.has_caption, d.sampled, d.pct_caption);
        html += renderMetaStat("bi-chat-square-text", "UserComment", d.has_comment, d.sampled, d.pct_comment);

        folderMetaStats.innerHTML = html;
        folderMetaStats.style.display = "block";
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
            } else {
                photoDirInput.value = selected;
                validateFolder(selected);
            }
        }
        browserTarget = null;
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
                    }
                })
                .catch(function() { /* ignore transient errors */ });
        }, 1000);
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
        }
    });
});
