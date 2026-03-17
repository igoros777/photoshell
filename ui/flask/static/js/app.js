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
    var docsModal    = new bootstrap.Modal(document.getElementById("docsModal"));
    var docsTitle    = document.getElementById("docs-modal-title");
    var docsLoading  = document.getElementById("docs-loading");
    var docsContent  = document.getElementById("docs-content");

    var currentJobId = null;
    var pollTimer    = null;
    var folderValid  = false;
    var validateTimer = null;

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

    function openDocsModal(docKey) {
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

                // Extract mermaid blocks BEFORE marked processes them,
                // to preserve raw text (marked would HTML-escape <br/> etc.)
                var mermaidBlocks = [];
                var mdContent = data.content.replace(
                    /```mermaid\s*\n([\s\S]*?)```/g,
                    function(match, diagram) {
                        var idx = mermaidBlocks.length;
                        mermaidBlocks.push(diagram.trim());
                        return '<div class="mermaid" data-mermaid-idx="' + idx + '"></div>';
                    }
                );

                var html = marked.parse(mdContent);
                docsLoading.style.display = "none";
                docsContent.innerHTML = html;
                docsContent.style.display = "block";

                // Insert raw mermaid source into placeholder divs and render
                var mermaidDivs = docsContent.querySelectorAll(".mermaid[data-mermaid-idx]");
                for (var i = 0; i < mermaidDivs.length; i++) {
                    var idx = parseInt(mermaidDivs[i].getAttribute("data-mermaid-idx"), 10);
                    if (mermaidBlocks[idx] !== undefined) {
                        mermaidDivs[i].textContent = mermaidBlocks[idx];
                    }
                }
                if (mermaidDivs.length > 0) {
                    mermaid.run({ nodes: mermaidDivs }).catch(function(e) {
                        console.warn("Mermaid rendering error:", e);
                    });
                }
            })
            .catch(function(err) {
                docsLoading.style.display = "none";
                docsContent.style.display = "block";
                docsContent.innerHTML = '<div class="text-danger">Failed to load documentation: ' + err + '</div>';
            });
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
            } else {
                item.classList.add("disabled");
                var collapse = item.querySelector(".accordion-collapse");
                if (collapse && collapse.classList.contains("show")) {
                    bootstrap.Collapse.getOrCreateInstance(collapse).hide();
                }
            }
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
                            '<i class="bi bi-folder-fill" style="color:var(--ps-warning)"></i> ' +
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
