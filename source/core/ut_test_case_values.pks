create or replace noneditionable package ut_test_case_values authid definer as
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
   * Holds the JSON text of the --%testcasesource test cases from the moment a test is split into its test cases
   * until each test case has run. The JSON text can't be an attribute of the suite item types, as it can be longer
   * than a varchar2 attribute.
   * Also holds the test cases that a run selects by path, e.g. "pkg.test[2]", for tests with a --%testcasesource.
   */

  procedure set_json(a_test_path varchar2, a_json clob);

  function get_json(a_test_path varchar2) return clob;

  procedure remove_json(a_test_path varchar2);

  /**
   * Sets the test cases a run selects, replacing those of an earlier run.
   * a_filters: key = owner || ':' || path of the test, value = number of a test case.
   */
  procedure set_case_filters(a_filters ut_key_value_pairs);

  /**
   * The numbers of the test cases selected for a test, empty when all its test cases run.
   */
  function get_case_filter(a_owner varchar2, a_test_path varchar2) return ut_integer_list;

end;
/
