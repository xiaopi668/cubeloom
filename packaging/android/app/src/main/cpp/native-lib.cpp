// JNI 入口：把参数交给 libnode 的 node::Start()，并在工作目录里启动。
#include <jni.h>
#include <string>
#include <vector>
#include <unistd.h>
#include "node.h"

extern "C" JNIEXPORT jint JNICALL
Java_io_github_cubeloom_NodeRuntime_startNode(JNIEnv* env, jclass /*clazz*/,
                                              jobjectArray args, jstring workDir) {
  jsize count = env->GetArrayLength(args);
  std::vector<std::string> storage;
  storage.reserve(static_cast<size_t>(count));
  for (jsize i = 0; i < count; i++) {
    auto js = static_cast<jstring>(env->GetObjectArrayElement(args, i));
    const char* utf = env->GetStringUTFChars(js, nullptr);
    storage.emplace_back(utf ? utf : "");
    env->ReleaseStringUTFChars(js, utf);
    env->DeleteLocalRef(js);
  }
  std::vector<char*> argv;
  argv.reserve(storage.size());
  for (auto& s : storage) argv.push_back(const_cast<char*>(s.c_str()));

  const char* wd = env->GetStringUTFChars(workDir, nullptr);
  if (wd && chdir(wd) != 0) {
    // 工作目录失败也继续，Node 侧会用绝对路径
  }
  if (wd) env->ReleaseStringUTFChars(workDir, wd);

  return node::Start(static_cast<int>(argv.size()), argv.data());
}
