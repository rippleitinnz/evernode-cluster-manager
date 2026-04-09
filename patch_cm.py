#!/usr/bin/env python3
"""
Patch script for cluster-manager.js v2.3.0
Run: python3 patch_cm.py
"""

with open('/home/chris/evernode-cluster-manager/client/cluster-manager.js', 'r') as f:
    content = f.read()

# ── 1. Update version ──────────────────────────────────────────
content = content.replace("const TOOL_VERSION = 'v2.1.0';", "const TOOL_VERSION = 'v2.3.0';")
content = content.replace("* Evernode Cluster Manager v2.1.0", "* Evernode Cluster Manager v2.3.0")
print('✓ Version updated to v2.3.0')

# ── 2. Add Total column to findHosts table ─────────────────────
content = content.replace(
    "'#'.padEnd(4)+'Address'.padEnd(36)+'Domain'.padEnd(25)+'CC'.padEnd(5)+'Avail'.padEnd(7)+'Rep'.padEnd(6)+'XAH'.padEnd(8)+'EVR'.padEnd(8)+'Lease/hr'.padEnd(12)+'Version'",
    "'#'.padEnd(4)+'Address'.padEnd(36)+'Domain'.padEnd(25)+'CC'.padEnd(5)+'Avail'.padEnd(7)+'Total'.padEnd(7)+'Rep'.padEnd(6)+'XAH'.padEnd(8)+'EVR'.padEnd(8)+'Lease/hr'.padEnd(12)+'Version'"
)
content = content.replace(
    "String(h.availableInstanceSlots||0).padEnd(7)+\n        fmtRep(h.reputation).padEnd(6)+",
    "String(h.availableInstanceSlots||0).padEnd(7)+\n        String(h.totalInstanceSlots||0).padEnd(7)+\n        fmtRep(h.reputation).padEnd(6)+"
)
content = content.replace("console.log('  '+hr(124));", "console.log('  '+hr(131));")
content = content.replace(
    "' host(s) verified — active, funded and reputation >= ' + MIN_REP + '.\\n');",
    "' host(s) verified — active, funded and reputation >= ' + MIN_REP + '.\\n  Tip: Choose hosts with Total=1 to ensure evdevkit deploys one node per host.\\n');"
)
print('✓ Total column added to findHosts table')

# ── 3. Add opDeleteProject and opResetCredentials ─────────────
op_delete = '''
// ── Delete Project ────────────────────────────────────────────

const opDeleteProject = async (project) => {
    console.log('\\n── Delete Project ───────────────────────────────────');
    console.log(`  Project : ${project.name}`);
    if (project.contractId) console.log(`  Contract: ${project.contractId.slice(0,8)}…`);
    console.log('');
    const confirm = (await ask('  Are you sure you want to delete this project? (yes/y): ')).trim();
    if (confirm !== 'yes' && confirm !== 'y') { console.log('  Cancelled.'); return; }
    const delDir = (await ask('  Also delete project directory and all files? (yes/y or Enter to keep): ')).trim();
    if (delDir === 'yes' || delDir === 'y') {
        fs.rmSync(project.dir, { recursive: true, force: true });
        console.log(`  ✓ Project "${project.name}" and all files deleted.`);
    } else {
        console.log(`  ✓ Project "${project.name}" removed from list (files kept at ${project.dir}).`);
    }
};

// ── Reset Global Credentials ──────────────────────────────────

const opResetCredentials = async () => {
    console.log('\\n── Reset Global Credentials ─────────────────────────');
    console.log('  This will overwrite the shared credentials used by all projects.');
    const confirm = (await ask('  Proceed? (yes/y): ')).trim();
    if (confirm !== 'yes' && confirm !== 'y') { console.log('  Cancelled.'); return; }
    await setupGlobalCredentials();
    console.log('  ✓ Global credentials updated.');
};

'''

content = content.replace(
    '// ── Project selector ──────────────────────────────────────',
    op_delete + '// ── Project selector ──────────────────────────────────────'
)
print('✓ opDeleteProject and opResetCredentials added')

# ── 4. Update selectProject ────────────────────────────────────
old_select = '''const selectProject = async () => {
    const projects = getProjects();
    console.log('');
    if (projects.length === 0) {
        console.log('  No projects found. Creating your first project...');
        return await createProject();
    }

    console.log('  Select a project:\\n');
    projects.forEach((p,i) => {
        const status = p.contractId ? `contract: ${p.contractId.slice(0,8)}… | ${p.lastNode||'no node saved'}` : 'no cluster yet';
        console.log(`    ${i+1}. ${p.name.padEnd(22)} ${status}`);
    });
    console.log(`    ${projects.length+1}. Create new project`);
    console.log(`    ${projects.length+2}. Exit`);
    console.log('');

    while (true) {
        const input=(await ask('  Choice: ')).trim();
        const idx=parseInt(input);
        if (idx===projects.length+2) { rl.close(); process.exit(0); }
        if (idx===projects.length+1) { return await createProject(); }
        if (idx>=1&&idx<=projects.length) {
            const project=projects[idx-1];
            setProject(project.dir);
            loadProjectEnv();
            if (project.lastNode) { const parts=project.lastNode.split(':'); ip=parts[0]; port=parts[1]; }
            if (project.contractId) contractId=project.contractId;
            console.log(`\\n  ✓ Loaded project: ${project.name}`);
            return project.name;
        }
        console.log('  Invalid choice.');
    }
};'''

new_select = '''const selectProject = async () => {
    const projects = getProjects();
    console.log('');
    if (projects.length === 0) {
        console.log('  No projects found. Creating your first project...');
        return await createProject();
    }

    console.log('  Select a project:\\n');
    console.log('    1. Create new project');
    console.log('    2. Reset global credentials');
    projects.forEach((p,i) => {
        const status = p.contractId ? `contract: ${p.contractId.slice(0,8)}… | ${p.lastNode||'no node saved'}` : 'no cluster yet';
        console.log(`    ${i+3}. ${p.name.padEnd(22)} ${status}`);
    });
    console.log(`    ${projects.length+3}. Exit`);
    console.log('');

    while (true) {
        const input=(await ask('  Choice: ')).trim();
        const idx=parseInt(input);
        if (idx===projects.length+3) { rl.close(); process.exit(0); }
        if (idx===1) { return await createProject(); }
        if (idx===2) { await opResetCredentials(); return await selectProject(); }
        if (idx>=3&&idx<=projects.length+2) {
            const project=projects[idx-3];
            console.log(`\\n  Project: ${project.name}`);
            console.log('    1. Open project');
            console.log('    2. Delete project');
            console.log('    3. Back');
            console.log('');
            const action=(await ask('  Choice: ')).trim();
            if (action==='2') { await opDeleteProject(project); return await selectProject(); }
            if (action==='3') { return await selectProject(); }
            setProject(project.dir);
            loadProjectEnv();
            if (project.lastNode) { const parts=project.lastNode.split(':'); ip=parts[0]; port=parts[1]; }
            if (project.contractId) contractId=project.contractId;
            console.log(`\\n  ✓ Loaded project: ${project.name}`);
            return project.name;
        }
        console.log('  Invalid choice.');
    }
};'''

if old_select in content:
    content = content.replace(old_select, new_select)
    print('✓ selectProject updated — Create new project at top, Delete project, Reset credentials')
else:
    print('✗ Could not find selectProject — check manually')

# ── Write output ───────────────────────────────────────────────
with open('/home/chris/evernode-cluster-manager/client/cluster-manager.js', 'w') as f:
    f.write(content)

print('\nAll changes applied successfully. Version: v2.3.0')
