cmake_minimum_required(VERSION 3.22)
project(cubeloom_node CXX)

add_library(cubeloom-node SHARED native-lib.cpp)

include_directories(${CMAKE_SOURCE_DIR}/libnode/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
    IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(cubeloom-node libnode ${log-lib})
