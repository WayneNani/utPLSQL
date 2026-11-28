create or replace noneditionable package body ut_test_case_values as
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

  type tt_json is table of clob index by varchar2(4000 char);
  type tt_filters is table of ut_integer_list index by varchar2(4000 char);
  g_json    tt_json;
  g_filters tt_filters;

  procedure set_json(a_test_path varchar2, a_json clob) is
  begin
    g_json(a_test_path) := a_json;
  end;

  function get_json(a_test_path varchar2) return clob is
  begin
    return case when g_json.exists(a_test_path) then g_json(a_test_path) end;
  end;

  procedure remove_json(a_test_path varchar2) is
  begin
    g_json.delete(a_test_path);
  end;

  procedure set_case_filters(a_filters ut_key_value_pairs) is
  begin
    g_filters.delete;
    for i in 1 .. cardinality(a_filters) loop
      if not g_filters.exists(a_filters(i).key) then
        g_filters(a_filters(i).key) := ut_integer_list();
      end if;
      g_filters(a_filters(i).key).extend;
      g_filters(a_filters(i).key)(g_filters(a_filters(i).key).last) := to_number(a_filters(i).value);
    end loop;
  end;

  function get_case_filter(a_owner varchar2, a_test_path varchar2) return ut_integer_list is
    l_key varchar2(4000 char) := upper(a_owner) || ':' || lower(a_test_path);
  begin
    return case when g_filters.exists(l_key) then g_filters(l_key) else ut_integer_list() end;
  end;

end;
/
