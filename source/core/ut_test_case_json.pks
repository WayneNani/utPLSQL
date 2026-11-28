create or replace noneditionable package ut_test_case_json authid current_user as
  /*
  utPLSQL - Version 3
  Copyright 2016 - 2026 utPLSQL Project

  Licensed under the Apache License, Version 2.0 (the "License").
  You may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
  */

  /**
   * Test cases given as JSON, by --%testcase or by a --%testcasesource function:
   * a JSON array passes its values by position, a JSON object passes its values to the parameters named like its keys.
   * Values and keys beyond the parameters are ignored, so that one source of test cases can serve several tests
   * and the description can show values that aren't passed (#1326).
   */

  /**
   * Returns the description of a JSON test case, with the values of the test case filled in (see ut_utils.get_test_case_description).
   * Values of a JSON array can be referred to by the names of the parameters they are passed to, given in a_parameter_names.
   * Text that is no JSON is appended to the description as it is.
   */
  function get_test_case_description(a_description varchar2, a_json clob, a_parameter_names ut_varchar2_list := null) return varchar2;

  /**
   * Returns a PL/SQL block that calls the procedure with the values of a JSON test case, converted to the types of its parameters.
   * The block expects the JSON text as bind variable :ut_json.
   * Raises ut_utils.gc_invalid_test_case_source when the test case can't be passed to the procedure, e.g. when it is no
   * JSON array or object, a parameter without default value gets no value, or the procedure has no parameters.
   */
  function get_call(a_owner varchar2, a_package varchar2, a_procedure varchar2, a_call_name varchar2, a_json clob) return varchar2;

end;
/
