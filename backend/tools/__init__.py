"""Tools package — re-exports all tool functions.

Usage: ``from backend import tools`` then ``tools.add_element(...)``.
"""

# WebSocket infrastructure & frontend status
from backend.tools.ws import (  # noqa: F401
    init_tools,
    send_command,
    handle_frontend_response,
    broadcast_console_log,
    _ws_broadcast,
    report_frontend_error,
    on_frontend_ready,
    on_frontend_disconnect,
    store_console_log,
    clear_stored_console_logs,
    get_console_logs,
    clear_console_logs,
    get_errors,
    get_frontend_status,
    get_console_logs_formatted,
    get_frontend_errors_formatted,
    clear_logs,
    get_active_tab_type,
)

# Canvas operations (nodes, connections, state, view, tooltips, subgraphs)
from backend.tools.canvas import (  # noqa: F401
    # Element CRUD (unified names)
    add_element,
    remove_element,
    get_element,
    update_element,
    get_elements,
    # Edges
    connect,
    disconnect,
    # State
    get_flowgraph,
    clear_canvas,
    auto_layout,
    # View
    fit_all,
    fit_node,
    zoom,
    get_viewport,
    screenshot,
    # Flow I/O
    save_tab,
    save_tab_as,
    load_tab,
    # Tooltips
    tooltip,
    hide_tooltip,
    clear_tooltips,
    # Subgraphs
    create_subgraph,
    set_subgraph,
    ungroup_subgraph,
    # Block registry
    get_block_schema,
    register_block_v2,
    search_block_types,
    get_tab_contents,
)

# Execution control
from backend.tools.execution import (  # noqa: F401
    start_execution,
    stop_execution,
    get_execution_result,
    step_start,
    step_next,
    step_reset,
    run_remaining,
    run_single_node,
    # v2
    get_execution_status,
)

# File I/O
from backend.tools.file_io import (  # noqa: F401
    save_flowgraph,
    load_flowgraph,
    reload_frontend,
    shutdown_server,
)

# Batch execution
from backend.tools.batch import (  # noqa: F401
    run_batch,
)

# Workspace operations (v2)
from backend.tools.workspaces import (  # noqa: F401
    open_tab,
    close_tab,
    switch_tab,
    get_tabs,
    list_saved,
    delete_tab,
    rename_tab,
)
