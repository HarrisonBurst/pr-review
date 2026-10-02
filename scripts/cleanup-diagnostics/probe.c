#include <node_api.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <errno.h>
#include <unistd.h>

static void number(napi_env env, napi_value object, const char *key, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  napi_set_named_property(env, object, key, result);
}

static napi_value snapshot(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1], result;
  int32_t pid;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  napi_get_value_int32(env, args[0], &pid);
  napi_create_object(env, &result);
  struct proc_bsdinfo data = {0};
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &data, sizeof(data));
  number(env, result, "errno", errno);
  number(env, result, "bytes", size);
  if (size != sizeof(data)) return result;
  number(env, result, "pid", data.pbi_pid);
  number(env, result, "ppid", data.pbi_ppid);
  number(env, result, "pgid", data.pbi_pgid);
  number(env, result, "uid", data.pbi_uid);
  number(env, result, "status", data.pbi_status);
  number(env, result, "startSeconds", data.pbi_start_tvsec);
  number(env, result, "startMicros", data.pbi_start_tvusec);
  return result;
}

static napi_value group(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1], result, members;
  int32_t pgid, pids[129] = {0};
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  napi_get_value_int32(env, args[0], &pgid);
  napi_create_object(env, &result);
  errno = 0;
  int size = proc_listpids(PROC_PGRP_ONLY, pgid, pids, sizeof(pids));
  number(env, result, "errno", errno);
  number(env, result, "bytes", size);
  napi_create_array(env, &members);
  int length = size > 0 && size <= sizeof(pids) ? size / sizeof(int32_t) : 0;
  for (int i = 0; i < length; i++) {
    napi_value pid;
    napi_create_int32(env, pids[i], &pid);
    napi_set_element(env, members, i, pid);
  }
  napi_set_named_property(env, result, "members", members);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"snapshot", NULL, snapshot, NULL, NULL, NULL, napi_default, NULL},
    {"group", NULL, group, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
